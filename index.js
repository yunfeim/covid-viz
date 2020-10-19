// extract a 4 or 5 digit FIPS code from a string
const FIPS_REGEX = new RegExp('(?<fips>\\d{4,5})$');

// ID of map object in HTML
const MAP_ID = 'map';

// locations of resources
const MAP_LOCATION = './usa_counties.svg';
const CUMULATIVE_CASES_LOCATION = './cumulative_cases.csv';
const POPULATIONS_LOCATION = './county_populations.csv';

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
};

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
    return fetch(MAP_LOCATION).then(res => res.text()).then(raw => {
        const parser = new DOMParser();
        const XMLTree = parser.parseFromString(raw, "image/svg+xml");
        const asNode = document.adoptNode(XMLTree.querySelector('svg'));
        document.getElementById(MAP_ID).replaceWith(asNode);
        asNode.id = MAP_ID;
        return asNode;
    });
};

// fetch the cumulative case-count CSV as a raw string
const getCumulativeCaseCSV = async () => {
    return fetch(CUMULATIVE_CASES_LOCATION).then(res => res.text());
};

// fetch the county population CSV as a string
const getPopulationCSV = async () => {
    return fetch(POPULATIONS_LOCATION).then(res => res.text());
};

/* process the cumulative case-count string into a
// time-series object indexed by FIPS codes, also
// returning a list of Date objects */
const processCumulativeCaseCSV = (rawCSV, dataStartColumn = 4) => {
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
    Object.entries(cumulativeSeries).forEach(([code, values]) => {
        changeSeries[code] = values.map((val, index, array) => {
            return index > 0 ? val - array[index - 1] : val;
        });
    });
    return changeSeries;
};

/* given a total time-series object indexed by FIPS codes,
// calculate an object that holds per-capita values */
const calculatePerCapitaSeries = (totalSeries, countyPopulations) => {
    const perCapitaSeries = {};
    Object.entries(totalSeries).forEach(([code, values]) => {
        const population = countyPopulations[code];
        perCapitaSeries[code] = values.map(
            val => population > 0 ? val / population : 0);
    });
    return perCapitaSeries;
};

// color the SVG using the provided mapping from FIPS codes to HTML hex codes
const colorizeMap = (colors = {}) => {
    const noDataColor = '#000000';
    document.getElementById(MAP_ID).querySelector('#counties')
        .childNodes.forEach(node => {
            const match = FIPS_REGEX.exec(node.id);
            // ignore irrelevant nodes
            if (match) {
                const countyFIPS = padFIPS(match.groups.fips);
                const color = colors.hasOwnProperty(countyFIPS) ?
                    colors[countyFIPS] : noDataColor;
                node.style.fill = color;
            }
        });
};

// get a color ranging from green to red based on the given z-score
const getGreenYellowRed = (zScore) => {
    const maxVal = 255;
    const blue = 0;

    const size = 1 / (1 + Math.exp(-zScore));
    const red = Math.floor(maxVal * size);
    const green = maxVal - red;

    const hexBase = 16;
    const hexStringsRGB = [red, green, blue].map(
        val => val.toString(hexBase).padStart(2, '0'));
    return `#${hexStringsRGB.join('')}`;
};

// find sum of an array
const getSum = (array) => array.reduce((acc, current) => acc + current, 0);

// find mean of an array
const getMean = (array) => array.length > 0 ? getSum(array) / array.length : 0;

/* convert a time-series object indexed by FIPS codes into a
// mapping from FIPS codes to array of colors produced by evaluating
// colorFn on time-series values */
const getColors = (series, colorFn) => {
    const allValues = [].concat(...Object.values(series));
    const mean = getMean(allValues);
    const squaredDeviations = allValues.map(val => (val - mean) ** 2);
    const std = Math.sqrt(getMean(squaredDeviations));

    const color = {};
    Object.entries(series).forEach(([code, series]) => {
        color[code] = series.map(val => {
            const normalized = std > 0 ? (val - mean) / std : 0.5;
            return colorFn(normalized);
        });
    });
    return color;
};

/* play an animation using the given time-series object,
// the given array of dates, the given frame rate (per second),
// and the given color function */
const playAnimation = (series, dates, frameRate = 20,
    colorFn = getGreenYellowRed) => {

    const colorSeries = getColors(series, colorFn);
    const millisBetweenFrames = 1000 / frameRate;

    // load frame of given index
    const loadFrame = (frameNum) => {
        const colors = {};
        Object.entries(colorSeries).forEach(([code, values]) => {
            colors[code] = values[frameNum];
        });
        colorizeMap(colors);

        // recurse on next frame
        const nextFrameNum = frameNum + 1;
        if (nextFrameNum < dates.length) {
            clearTimeout(CURRENT_TIMEOUT_ID);
            CURRENT_TIMEOUT_ID = setTimeout(
                () => loadFrame(nextFrameNum),
                millisBetweenFrames);
        }
    };
    loadFrame(0);
};

/* main action on page */
const main = async () => {
    const resources = Promise.all([loadMap(),
    getCumulativeCaseCSV().then(processCumulativeCaseCSV),
    getPopulationCSV().then(processPopulationCSV)]);
    resources.then(([mapSVG,
        { datesArray, cumulativeSeries }, countyPopulations]) => {
        const changeSeries = calculateChangeSeries(
            cumulativeSeries);
        const changePerCapitaSeries = calculatePerCapitaSeries(
            changeSeries, countyPopulations);
        const sevenDayTrailing = getTrailingAverageSeries(
            changePerCapitaSeries, 7);
        playAnimation(
            sevenDayTrailing, datesArray);
    });
};

main();