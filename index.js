// extract a 4 or 5 digit FIPS code from a string
const FIPS_REGEX = new RegExp('(?<fips>\\d{4,5})$');

// ID of map object in HTML
const MAP_ID = 'map';

// ID of date box in HTML
const DATE_DISPLAY_ID = 'date-display';

// locations of resources
const MAP_LOCATION = './usa_counties.svg';
const CUMULATIVE_CASES_LOCATION = './cumulative_cases.csv';
const CUMULATIVE_DEATHS_LOCATION = './cumulative_deaths.csv';
const POPULATIONS_LOCATION = './county_populations.csv';

// mapping of datasets, indexed by bitwise OR of flags below
const DATASETS = {};

// dates used for the visualization
let DATES;

// populations of each county, indexed by FIPS code
let COUNTY_POPULATIONS;

// flag for whether dataset represents cases or deaths
const QUANTITY = { cases: 0, deaths: 1 };

// flag for whether dataset represents cumulative values or change
const TYPE = { cumulative: 0, change: 2 };

// flag for whether dataset represents totals or per-capita values
const VALUE = { total: 0, perCapita: 4 };

// ID of the current task to ensure only one task is active at any time
let CURRENT_TASK;

const maxFlag = getSum([QUANTITY, TYPE, VALUE].map(
    flags => getSum(Object.values(flags))));

/* Retrieve a dataset from the provided flag.
// Return a promise that resolves to the desired dataset */
const getDataset = async (datasetFlag) => {
    // check that flag is in bounds
    if (datasetFlag < 0 || maxFlag < datasetFlag) {
        throw `Unknown flag: ${datasetFlag}`;
    }

    // calculate dataset if not present
    if (!DATASETS[datasetFlag]) {
        // 'relative' dataset: get corresponding absolute dataset
        // as well as county populations, then process
        if (datasetFlag >= VALUE.perCapita) {
            const countyPopulations = COUNTY_POPULATIONS ?
                Promise.resolve(COUNTY_POPULATIONS) :
                getPopulationCSV().then(processPopulationCSV);

            DATASETS[datasetFlag] = Promise.all(
                [getDataset(datasetFlag - VALUE.perCapita), countyPopulations]
            ).then(
                ([total, populations]) => calculatePerCapitaSeries(
                    total, populations)
            );
        }

        // 'change' dataset: get corresponding cumulative dataset, then process
        else if (datasetFlag >= TYPE.change) {
            DATASETS[datasetFlag] = getDataset(datasetFlag - TYPE.change)
                .then(calculateChangeSeries);
        }

        // recursive base cases:
        // absolute cumulative deaths or cases
        else {
            const getCSV = (datasetFlag === QUANTITY.deaths) ?
                getCumulativeDeathCSV :
                getCumulativeCaseCSV;

            DATASETS[datasetFlag] = getCSV().then(processCumulativeCSV).then(
                ({ datesArray, cumulativeSeries }) => {
                    DATES = datesArray;
                    return cumulativeSeries;
                }
            );
        }
    }
    return DATASETS[datasetFlag];
};

// ID of active setTimeout
let CURRENT_TIMEOUT_ID;

// ensure that a FIPS code has 5 digits by padding with 0 if needed
const padFIPS = (fipsCode) => fipsCode.padStart(5, '0');

// retrieve a 2D array from raw CSV string
const getArrayFromCSV = (rawCSV) => {
    return rawCSV.split('\n').map(line => line.split(','));
};

/* class for efficiently finding a trailing average */
class AverageBuffer {
    constructor(size) {
        this.size = size;
        this.internal = [];
        this.index = 0;
        this.currentAverage = 0;
    }

    // feed new value into buffer
    update(newVal) {
        if (this.internal.length < this.size) {
            this.currentAverage = (
                (this.currentAverage * this.internal.length) + newVal
            ) / (this.internal.length + 1);
            this.internal.push(newVal);
        }
        else {
            const oldVal = this.internal[this.index];
            this.internal[this.index] = newVal;
            this.index = (this.index + 1) % this.size;
            this.currentAverage += (newVal - oldVal) / this.size;
        }
    }

    // get current average
    get average() {
        return this.currentAverage;
    }
}

/* given a time-series object indexed by FIPS codes,
// convert each sequence of values into a trailing average. */
const getTrailingAverageSeries = (series, trailSize = 1) => {
    const newSeries = {};
    Object.entries(series).forEach(([key, values]) => {
        const buffer = new AverageBuffer(trailSize);
        newSeries[key] = values.map(val => {
            buffer.update(val);
            return buffer.average;
        });
    });
    return newSeries;
}

// fetch the SVG county-level map and insert into HTML document
const loadMap = async () => {
    fetch(MAP_LOCATION).then(res => res.text()).then(raw => {
        const parser = new DOMParser();
        const XMLTree = parser.parseFromString(raw, "image/svg+xml");
        const asNode = document.adoptNode(XMLTree.querySelector('svg'));
        document.getElementById(MAP_ID).replaceWith(asNode);
        asNode.id = MAP_ID;
    });
}

// fetch a mapping from FIPS codes to SVG nodes
const getCountyNodes = (svgMap) => {
    const countyNodes = {};
    svgMap.querySelector('#counties').childNodes.forEach(node => {
        const match = FIPS_REGEX.exec(node.id);
        // ignore irrelevant nodes
        if (match) {
            const countyFIPS = padFIPS(match.groups.fips);
            countyNodes[countyFIPS] = node;
        }
    });
    return countyNodes;
};

// fetch the cumulative case-count CSV as a raw string
const getCumulativeCaseCSV = async () => {
    return fetch(CUMULATIVE_CASES_LOCATION).then(res => res.text());
};

const getCumulativeDeathCSV = async () => {
    return fetch(CUMULATIVE_DEATHS_LOCATION).then(res => res.text());
}

// fetch the county population CSV as a string
const getPopulationCSV = async () => {
    return fetch(POPULATIONS_LOCATION).then(res => res.text());
};

/* process the cumulative case-count string into a
// time-series object indexed by FIPS codes, also
// returning a list of Date objects */
const processCumulativeCSV = (rawCSV, dataStartColumn = 4) => {
    const cells = getArrayFromCSV(rawCSV);
    const cumulativeSeries = {};
    cells.slice(1).forEach(line => {
        const code = line[0];
        if (FIPS_REGEX.test(code)) {
            const countyFIPS = padFIPS(code);
            const stringVals = line.slice(dataStartColumn);
            cumulativeSeries[countyFIPS] = stringVals.map(Number);
        }
    });
    const datesArray = cells[0].slice(dataStartColumn)
        .map(string => new Date(string));

    // ensure that values in cumulative series are non-decreasing
    validateCumulative(cumulativeSeries);
    return { datesArray, cumulativeSeries };
};

/* process the cumulative case-count string into an
// object mapping FIPS codes to populations */
const processPopulationCSV = (rawCSV, dataColumn = 3) => {
    const cells = getArrayFromCSV(rawCSV);
    const populations = {};
    cells.slice(1).forEach(line => {
        const code = line[0];
        if (FIPS_REGEX.test(code)) {
            const countyFIPS = padFIPS(code);
            populations[countyFIPS] = Number(line[dataColumn]);
        }
    });
    return populations;
};

/* preprocess a cumulative time-series object indexed by FIPS codes
// by ensuring that all sequences are non-decreasing */
const validateCumulative = (cumulativeSeries) => {
    Object.entries(cumulativeSeries).forEach(([key, values]) => {
        let runningMax = 0;
        cumulativeSeries[key] = values.map(val => {
            runningMax = Math.max(val, runningMax)
            return runningMax;
        });
    });
    return cumulativeSeries;
};

/* given a cumulative time-series object indexed by FIPS codes,
// calculate an object that holds change rather than accumulation */
const calculateChangeSeries = (cumulativeSeries) => {
    const changeSeries = {};
    Object.entries(cumulativeSeries).forEach(([code, series]) => {
        changeSeries[code] = series.map(
            (val, index, array) => (index > 0 ? val - array[index - 1] : val)
        );
    });
    return changeSeries;
};

/* given a total time-series object indexed by FIPS codes,
// calculate an object that holds per-capita values */
const calculatePerCapitaSeries = (totalSeries, countyPopulations) => {
    const perCapitaSeries = {};
    Object.entries(totalSeries).forEach(([code, series]) => {
        const population = countyPopulations[code];
        perCapitaSeries[code] = series.map(
            val => population > 0 ? val / population : 0
        );
    });
    return perCapitaSeries;
};

// color the SVG using the provided mapping from FIPS codes to HTML hex codes
const colorizeMap = (countyElements, colors) => {
    const fallbackColor = 'white';
    Object.entries(countyElements).forEach(([code, mapNode]) => {
        const color = colors.hasOwnProperty(code) ? colors[code] : fallbackColor;
        mapNode.style.fill = color;
    });
};

// get a hue ranging from green to yellow to red based on the given z-score
const getHue = (zScore) => {
    return 120 / (1 + Math.exp(zScore));
};

/* get a lightness value ranging from light to dark based on
// relative population (input between 0 to 1, corresponding to min and max) */
const getLightness = (relativePopulation) => {
    const lowDensityEnd = 0.8;
    const highDensityEnd = 0.4;
    const range = lowDensityEnd - highDensityEnd;
    return toPercentString(lowDensityEnd - (relativePopulation * range));
};

// find sum of an array
function getSum(array) {
    return array.reduce((acc, current) => acc + current, 0)
};

// find mean of an array
function getMean(array) {
    return array.length > 0 ? getSum(array) / array.length : 0
};

// find standard deviation of array
function getStdev(array, mean) {
    if (mean === undefined) {
        mean = getMean(array);
    }
    const squaredDevs = array.map(val => (val - mean) ** 2);
    return Math.sqrt(getMean(squaredDevs));
};

// find a z-score given mean and standard deviation
function getZscore(val, mean, stdev) {
    if (mean === undefined || stdev === undefined) {
        throw 'Please provide mean and standard deviation';
    }
    return stdev > 0 ? (val - mean) / stdev : 0;
};

// convert decimal to integer percent
function toPercentString(decimal) {
    return `${Math.round(100 * decimal)}%`;
}

// get scaled value between 0 and 1
function getRelativeAmount(amount, min, range) {
    return range > 0 ? (amount - min) / range : min;
};

/* convert a time-series object indexed by FIPS codes into a
// mapping from FIPS codes to array of colors produced by evaluating
// colorFn on time-series values */
const getColors = (countSeries, getHue, populations, getLightness) => {
    const defaultLightness = '60%';
    const allCounts = [].concat(...Object.values(countSeries));
    const meanCounts = getMean(allCounts);
    const stdevCounts = getStdev(allCounts, meanCounts);

    let getLightnessFromCode;
    if (!(populations && getLightness)) {
        getLightnessFromCode = () => defaultLightness;
    }
    else {
        const allPopulations = Object.values(populations);
        const maxPopulation = Math.max(...allPopulations);
        const minPopulation = Math.min(...allPopulations);
        const populationRange = maxPopulation - minPopulation;
        getLightnessFromCode = (code) => getLightness(
            getRelativeAmount(populations[code], minPopulation, populationRange
            ));
    }

    const color = {};
    Object.entries(countSeries).forEach(([code, series]) => {
        color[code] = series.map(val => {
            const normalizedCount = getZscore(val, meanCounts, stdevCounts);
            const hue = getHue(normalizedCount);
            const lightness = getLightnessFromCode(code);
            return `hsl(${hue}, 100%, ${lightness})`;
        });
    });
    return color;
};

/* Convert date into custom string representation for display */
const formatDate = (date) => {
    const fullString = date.toUTCString();
    const [start, end] = [5, 16];
    return fullString.slice(start, end);
}

/* play an animation using the given time-series object,
// the given array of dates, the given frame rate (per second),
// and the given color function */
const playAnimation = (caseSeries, populations, frameRate = 10) => {

    const colorSeries = populations ?
        getColors(caseSeries, getHue, populations, getLightness) :
        getColors(caseSeries, getHue);
    const millisBetweenFrames = 1000 / frameRate;

    const countyNodes = getCountyNodes(document.getElementById(MAP_ID));
    const dateElem = document.getElementById(DATE_DISPLAY_ID);
    const dateStrings = DATES.map(formatDate);

    // set current task as running
    const taskID = Date.now();
    CURRENT_TASK = taskID;

    // load frame of given index
    const loadFrame = (frameNum) => {
        // terminate if new task is running
        if (CURRENT_TASK !== taskID) {
            return;
        }
        dateElem.textContent = dateStrings[frameNum];
        const colors = {};
        Object.entries(colorSeries).forEach(
            ([code, series]) => colors[code] = series[frameNum]
        );
        colorizeMap(countyNodes, colors);

        // recurse on next frame
        const nextFrameNum = frameNum + 1;
        if (nextFrameNum < dateStrings.length) {
            clearTimeout(CURRENT_TIMEOUT_ID);
            CURRENT_TIMEOUT_ID = setTimeout(
                () => loadFrame(nextFrameNum),
                millisBetweenFrames);
        }
    };
    loadFrame(0);
};

class Button {
    constructor(element) {
        this.element = element;
        this.isSelected = false;
    }

    select() {
        this.element.classList.toggle('selected', true);
        this.isSelected = true;
    }

    deselect() {
        this.element.classList.toggle('selected', false);
        this.isSelected = false;
    }

    get selected() {
        return this.isSelected;
    }

    setOpposingButton(opposing) {
        this.element.addEventListener('click', () => {
            this.select();
            opposing.deselect();
        });
        opposing.element.addEventListener('click', () => {
            opposing.select();
            this.deselect();
        });
    }
}

/* load buttons from HTML and create mapping from strings to Button class*/
const loadButtons = () => {
    const [cases, deaths] = document.querySelectorAll('#quantity>*');
    const [cumulative, change] = document.querySelectorAll('#type>*');
    const [absolute, perCapita] = document.querySelectorAll('#value>*');
    const elements = { cases, deaths, cumulative, change, absolute, perCapita };
    const buttons = {};
    Object.entries(elements).forEach(([name, element]) => {
        buttons[name] = new Button(element);
    });
    return buttons;
}

const initializeButtons = (buttons) => {
    const {
        cases, deaths, cumulative, change, absolute, perCapita
    } = buttons;

    cases.setOpposingButton(deaths);
    cumulative.setOpposingButton(change);
    absolute.setOpposingButton(perCapita);

    // set initial options
    cases.select();
    change.select();
    perCapita.select();
};

/* find the desired dataset flag given the user's selected options */
const calculateDatasetFlag = (buttons) => {
    const { deaths, change, perCapita } = buttons;
    let flag = 0;
    flag += deaths.selected ? QUANTITY.deaths : QUANTITY.cases;
    flag += change.selected ? TYPE.change : TYPE.cumulative;
    flag += perCapita.selected ? VALUE.perCapita : VALUE.absolute;
    return flag;
}

/* main action on page */
const main = async () => {
    const buttons = loadButtons();
    initializeButtons(buttons);
    await loadMap();
    const playButton = document.getElementById('play-button');
    playButton.addEventListener('click', async () => {
        const datasetID = calculateDatasetFlag(buttons);
        const dataset = await getDataset(datasetID);
        playAnimation(dataset);
    });
};

main();