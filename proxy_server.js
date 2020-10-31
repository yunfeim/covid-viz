const serverCreator = require('express');
const fetch = require('node-fetch');
const fileSystem = require('fs');

const PROXY = serverCreator();
const PORT = 8888;

const LOG_LOC = 'data/log.txt';

const CUMULATIVE_CASES_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_confirmed_usafacts.csv';
const CUMULATIVE_CASES_CACHE = 'data/cumulative_cases.csv';
const CUMULATIVE_CASES_META = 'data/cumulative_cases_timestamp.json';

const CUMULATIVE_DEATHS_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_deaths_usafacts.csv';
const CUMULATIVE_DEATHS_CACHE = 'data/cumulative_deaths.csv';
const CUMULATIVE_DEATHS_META = 'data/cumulative_deaths_timestamp.json';

const COUNTY_POPULATIONS_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_county_population_usafacts.csv';
const COUNTY_POPULATIONS_CACHE = 'data/county_populations.csv';
const COUNTY_POPULATIONS_META = 'data/county_populations_timestamp.json';

// how many milliseconds a cached file is effective for
// currently 24 hours
const CACHE_LIFETIME_MILLISEC = 1000 * 60 * 60 * 24;

// write a message to the log file at `LOG_LOC`
const writeToLog = (message) => {
    fileSystem.appendFileSync(LOG_LOC, `${message}\n`);
}

// function to set up endpoint for data file that is cached as well as updated
const initializeDataEndpoint = (cachePath, metaPath, remoteURL) => {
    const UTF_8 = 'utf-8';

    PROXY.get(`/${cachePath}`, async (request, response) => {
        // find timestamp of cached file
        const cacheTime = (() => {
            try {
                return Number(fileSystem.readFileSync(metaPath, UTF_8));
            }
            catch {
                return NaN;
            }
        })();
        const currentTime = Date.now();
        let data;
        // if cached copy is not outdated, return cached copy
        if (isFinite(cacheTime) &&
            (currentTime - cacheTime < CACHE_LIFETIME_MILLISEC)
        ) {
            data = fileSystem.readFileSync(cachePath, UTF_8);
        }

        // if cached copy is outdated, fetch new copy from remote
        // and update cache timestamp
        else {
            const logMessage = `[${new Date()}] Fetching from ${remoteURL}`;
            console.log(logMessage);
            writeToLog(logMessage);
            data = await fetch(remoteURL).then(res => res.text());
            fileSystem.writeFileSync(cachePath, data);
            fileSystem.writeFileSync(metaPath, String(currentTime));
        }
        response.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        response.send(data);
        response.end();
    });
};

// set up dataset endpoints
initializeDataEndpoint(CUMULATIVE_CASES_CACHE, CUMULATIVE_CASES_META,
    CUMULATIVE_CASES_REMOTE);
initializeDataEndpoint(CUMULATIVE_DEATHS_CACHE, CUMULATIVE_DEATHS_META,
    CUMULATIVE_DEATHS_REMOTE);
initializeDataEndpoint(COUNTY_POPULATIONS_CACHE, COUNTY_POPULATIONS_META,
    COUNTY_POPULATIONS_REMOTE);

// function to block external access to the provided path by returning a 403
const blockEndpoint = (path) => {
    PROXY.get(`/${path}`, (req, res) => res.send(403).end());
};

// block access to auxiliary files
[CUMULATIVE_CASES_CACHE, CUMULATIVE_CASES_META,
    CUMULATIVE_DEATHS_CACHE, CUMULATIVE_DEATHS_META,
    COUNTY_POPULATIONS_CACHE, COUNTY_POPULATIONS_META].forEach(
        path => blockEndpoint(path));

// block access to server logs
blockEndpoint(LOG_LOC);

PROXY.listen(PORT, () => {
    const startMessage = `[${new Date()}] Server listening on ${PORT}`;
    console.log(startMessage);
    writeToLog(startMessage);
});