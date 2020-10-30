// extract a 4 or 5 digit FIPS code from a string
const FIPS_REGEX = new RegExp('(?<fips>\\d{4,5})$');

// ID's of HTML elements and useful attributes
const HTML_IDS = {
    MAP: 'map',
    DATE_DISPLAY: 'date-display',
    TRAILING_AVERAGE: 'trailing-average',
    START_DATE: 'start-date',
    END_DATE: 'end-date',
    SPEED: 'speed',
    HELP_SYSTEM: 'help-system',
    OPTIONS_CONTAINER: 'options-container',
    PLAY_BUTTON: 'play-button'
}
const HTML_ATTRS = {
    DATA_HELP: 'data-help'
}

// locations of resources
const MAP_LOCATION = './usa_counties.svg';
const CUMULATIVE_CASES_LOCATION = './data/cumulative_cases.csv';
const CUMULATIVE_DEATHS_LOCATION = './data/cumulative_deaths.csv';
const POPULATIONS_LOCATION = './data/county_populations.csv';

const EARLIEST_START_DATE = "2020-01-22";
const DEFAULT_START_DATE = "2020-03-01";

/* mapping of datasets, calculated on an as-needed basis.
// also has county populations stored as `populationKey`.
// each dataset ID consist of two parts as encoded by the `encode` function:
// a source flag, which is a bitwise OR of the values from the flags below,
// as well as an integer for the size of the trailing average */
const DATASETS = {};

// find the key for the dataset with the given source flag and
// trailing average information
const encode = (sourceFlag, trailingAverage) => (
    `${sourceFlag}-${trailingAverage}`
);

// key for population dataset
const POPULATION_KEY = 'populations';

// flag for whether dataset represents cases or deaths
const QUANTITY = { cases: 0, deaths: 1 };

// flag for whether dataset represents cumulative values or change
const TYPE = { cumulative: 0, change: 2 };

// flag for whether dataset represents totals or per-capita values
const VALUE = { total: 0, perCapita: 4 };

const maxFlag = getSum([QUANTITY, TYPE, VALUE].map(
    flags => getSum(Object.values(flags))));

/* Retrieve a dataset from the provided identifiers.
// Return a promise that resolves to the desired dataset */
const getBasicDataset = async (sourceFlag, trailingAverage = 1) => {
    // check that source flag is in bounds
    if (!(0 <= sourceFlag && sourceFlag <= maxFlag)) {
        throw `Unknown flag: ${sourceFlag}`;
    }
    // check that trailing average is positive
    if (!(trailingAverage > 0)) {
        throw 'Trailing average must be positive';
    }

    const datasetKey = encode(sourceFlag, trailingAverage);

    // calculate dataset if not present
    if (!DATASETS[datasetKey]) {
        // 'per capita' dataset: get corresponding total dataset
        // as well as county populations, then process
        if (sourceFlag >= VALUE.perCapita) {
            const totalDataset = getBasicDataset(
                sourceFlag - VALUE.perCapita, trailingAverage
            );

            const countyPopulations = DATASETS[POPULATION_KEY] ?
                Promise.resolve(DATASETS[POPULATION_KEY]) :
                getPopulationCSV().then(processPopulationCSV);

            DATASETS[datasetKey] = Promise.all(
                [totalDataset, countyPopulations]
            ).then(
                ([[dates, total], populations]) => {
                    DATASETS[POPULATION_KEY] = populations;
                    const perCapita = calculatePerCapitaSeries(
                        total, populations);
                    return [dates, perCapita];
                }
            );
        }

        // 'change' dataset: get corresponding cumulative dataset, then process
        else if (sourceFlag >= TYPE.change) {
            const cumulativeDataset = getBasicDataset(
                sourceFlag - TYPE.change, trailingAverage
            );

            DATASETS[datasetKey] = cumulativeDataset.then(
                ([dates, cumulative]) => {
                    const change = calculateChangeSeries(cumulative);
                    return [dates, change];
                });
        }

        // base cases for source flag:
        // total cumulative deaths or cases
        else {
            const getBaseCSV = (sourceFlag === QUANTITY.deaths) ?
                getCumulativeDeathCSV :
                getCumulativeCaseCSV;

            const trailingAverageBaseCase = 1;
            const baseDatasetKey = encode(sourceFlag, trailingAverageBaseCase);
            DATASETS[baseDatasetKey] = getBaseCSV()
                .then(processCumulativeCSV).then(
                    (
                        { datesArray, cumulativeSeries }
                    ) => [datesArray, cumulativeSeries]
                );

            // apply trailing average to corresponding base dataset
            // unless the trailing average is 1 (no processing needed)
            if (trailingAverage !== trailingAverageBaseCase) {
                DATASETS[datasetKey] = DATASETS[baseDatasetKey].then(
                    ([dates, baseSeries]) => [
                        dates,
                        getTrailingAverageSeries(baseSeries, trailingAverage)
                    ]
                );
            }
        }
    }
    return DATASETS[datasetKey];
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
        document.getElementById(HTML_IDS.MAP).replaceWith(asNode);
        asNode.id = HTML_IDS.MAP;
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

/* trim the period of a dataset to between startDate and endDate */
const trimPeriod = (dataset, startDate, endDate) => {
    const [dates, series] = dataset;
    let startIndex = 0;
    for (; startIndex < dates.length; startIndex++) {
        if (startDate <= dates[startIndex]) {
            break;
        }
    }
    let endIndex = dates.length - 1;
    for (; endIndex >= 0; endIndex--) {
        if (endDate >= dates[endIndex]) {
            break;
        }
    }
    const arraySlicer = array => array.slice(startIndex, endIndex + 1);
    const newDates = arraySlicer(dates);
    const newDataset = {};
    Object.entries(series).forEach(([code, values]) => {
        newDataset[code] = arraySlicer(values);
    });
    return [newDates, newDataset];
}

// color the SVG using the provided mapping from FIPS codes to HTML hex codes
const colorizeMap = (countyElements, colors) => {
    const fallbackColor = 'white';
    Object.entries(countyElements).forEach(([code, mapNode]) => {
        const color = colors.hasOwnProperty(code) ?
            colors[code] :
            fallbackColor;
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

/* Return a function that plays an animation.
// ensures that only one animation is active at any time */
const getAnimator = () => {
    // ID of the current task to ensure only one task is active at any time
    let current_task;

    /* play an animation using the given time-series object,
    // the given array of dates, the given frame rate (per second),
    // and the given color function */
    const playAnimation = ([dates, caseSeries], populations, frameRate) => {
        const colorSeries = populations ?
            getColors(caseSeries, getHue, populations, getLightness) :
            getColors(caseSeries, getHue);
        const millisBetweenFrames = 1000 / frameRate;

        const countyNodes = getCountyNodes(document.getElementById(HTML_IDS.MAP));
        const dateElem = document.getElementById(HTML_IDS.DATE_DISPLAY);
        const dateStrings = dates.map(formatDate);

        // set current task as running
        const taskID = Date.now();
        current_task = taskID;

        // load frame of given index
        const loadFrame = (frameNum) => {
            // terminate if new task is running
            if (current_task !== taskID) {
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

    return playAnimation;
}

class Button {
    selectedClass = 'selected';
    spotlightedClass = 'spotlighted';
    overshadowedClass = 'overshadowed';

    constructor(element) {
        this.element = element;
        this.isSelected = false;
    }

    select() {
        this.element.classList.toggle(this.selectedClass, true);
        this.isSelected = true;
    }

    deselect() {
        this.element.classList.toggle(this.selectedClass, false);
        this.isSelected = false;
    }

    get selected() {
        return this.isSelected;
    }

    setMouseActionWithOpposing(opposing) {
        this.element.addEventListener('click', () => {
            this.select();
            opposing.deselect();
        });
        opposing.element.addEventListener('click', () => {
            opposing.select();
            this.deselect();
        });
        this.element.addEventListener('mouseenter', () => {
            this.element.classList.toggle(this.spotlightedClass, true);
            opposing.element.classList.toggle(this.overshadowedClass, true);
        });

        this.element.addEventListener('mouseleave', () => {
            this.element.classList.toggle(this.spotlightedClass, false);
            opposing.element.classList.toggle(this.overshadowedClass, false);
        });

        opposing.element.addEventListener('mouseenter', () => {
            opposing.element.classList.toggle(this.spotlightedClass, true);
            this.element.classList.toggle(this.overshadowedClass, true);
        });

        opposing.element.addEventListener('mouseleave', () => {
            opposing.element.classList.toggle(this.spotlightedClass, false);
            this.element.classList.toggle(this.overshadowedClass, false);
        });
    }
}

class RangeSelector {
    constructor(input, display) {
        this.input = input;
        this.display = display;

        this.display.textContent = this.input.value;

        this.input.addEventListener('input', () => {
            this.display.textContent = this.input.value;
        });
    }

    get value() {
        return this.input.value;
    }
};

/* load buttons from HTML and create mapping from strings to Button
// and RangeSelector classes */
const loadInputs = () => {
    const [cases, deaths] = document.querySelectorAll('#quantity>*');
    const [cumulative, change] = document.querySelectorAll('#type>*');
    const [total, perCapita] = document.querySelectorAll('#value>*');
    const elements = { cases, deaths, cumulative, change, total, perCapita };
    const buttons = {};
    Object.entries(elements).forEach(([name, element]) => {
        buttons[name] = new Button(element);
    });

    const trailingAverageSelector = (() => {
        const input = document.getElementById(HTML_IDS.TRAILING_AVERAGE);
        const display = input.previousElementSibling;
        return new RangeSelector(input, display);
    })();

    const speedSelector = (() => {
        const input = document.getElementById(HTML_IDS.SPEED);
        const display = input.previousElementSibling;
        return new RangeSelector(input, display);
    })();

    const startDateSelector = document.getElementById(HTML_IDS.START_DATE);
    const endDateSelector = document.getElementById(HTML_IDS.END_DATE);

    return { buttons, rangeSelectors: { trailingAverageSelector, speedSelector }, valueSelectors: { startDateSelector, endDateSelector } };
}

const initializeInputs = ({ buttons, valueSelectors }) => {
    const {
        cases, deaths, cumulative, change, total, perCapita
    } = buttons;

    cases.setMouseActionWithOpposing(deaths);
    cumulative.setMouseActionWithOpposing(change);
    total.setMouseActionWithOpposing(perCapita);

    // set default selection for buttons
    cases.select();
    change.select();
    perCapita.select();

    // set default dates for date selectors
    const { startDateSelector, endDateSelector } = valueSelectors;
    startDateSelector.value = DEFAULT_START_DATE;
    startDateSelector.min = EARLIEST_START_DATE;
    const currentDate = (() => {
        const date = new Date();
        const process = num => String(num).padStart(2, '0');
        return `${date.getUTCFullYear()
            }-${process(1 + date.getUTCMonth()) // 0-indexed
            }-${process(date.getUTCDate()) // 1-indexed
            }`;
    })();
    endDateSelector.value = currentDate;
    endDateSelector.max = currentDate;
};

/* set up the help icons to display a help dialog */
const initializeHelpDialogs = async () => {
    const helpSystem = document.getElementById(HTML_IDS.HELP_SYSTEM).content;
    const helpSVG = await fetch('./question-mark.svg')
        .then(res => res.text()).then(raw => {
            const parser = new DOMParser();
            return parser.parseFromString(raw, 'image/svg+xml')
                .querySelector('svg');
        });

    const optionsContainer = document.getElementById(HTML_IDS.OPTIONS_CONTAINER);
    for (const option of optionsContainer.children) {
        if (option.hasAttribute(HTML_ATTRS.DATA_HELP)) {
            const [helpButton, helpDialog] = helpSystem
                .cloneNode(true).children;
            option.append(helpButton, helpDialog);
            const icon = document.adoptNode(helpSVG.cloneNode(true));
            helpButton.querySelector('svg').replaceWith(icon);
            helpDialog.textContent = option.getAttribute(HTML_ATTRS.DATA_HELP);
            helpButton.addEventListener('click', () => {
                helpDialog.hidden = !helpDialog.hidden;
            });
        }
    }
};

/* play the animation matching the user's selected options */
const playAnimationFromInput = async (
    { buttons, rangeSelectors, valueSelectors }
) => {
    const { deaths, change, perCapita } = buttons;
    let sourceFlag = 0;
    sourceFlag += deaths.selected ? QUANTITY.deaths : QUANTITY.cases;
    sourceFlag += change.selected ? TYPE.change : TYPE.cumulative;
    sourceFlag += perCapita.selected ? VALUE.perCapita : VALUE.total;

    const { trailingAverageSelector, speedSelector } = rangeSelectors;
    const basic = await getBasicDataset(sourceFlag, trailingAverageSelector.value);

    const { startDateSelector, endDateSelector } = valueSelectors;
    const trimmed = trimPeriod(basic,
        new Date(startDateSelector.value), new Date(endDateSelector.value));

    const playAnimation = getAnimator();
    playAnimation(trimmed, undefined, speedSelector.value);
}

/* main action on page */
const main = async () => {
    const { buttons, rangeSelectors, valueSelectors } = loadInputs();
    initializeInputs({ buttons, valueSelectors });
    await initializeHelpDialogs();
    await loadMap();
    const playButton = document.getElementById(HTML_IDS.PLAY_BUTTON);
    playButton.addEventListener('click', () => {
        playAnimationFromInput({ buttons, rangeSelectors, valueSelectors });
    });
};

main();