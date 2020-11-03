const serverCreator = require('express');
const fetch = require('node-fetch');
const fileSystem = require('fs');

const PROXY = serverCreator();
const PORT = 8888;

// location of server log relative to current file
const LOG_LOC = 'proxy_data/log.txt';

// locations of data endpoints
const CUMULATIVE_CASES_ENDPOINT = 'proxy_data/cumulative_cases.csv';
const CUMULATIVE_DEATHS_ENDPOINT = 'proxy_data/cumulative_deaths.csv';
const COUNTY_POPULATIONS_ENDPOINT = 'proxy_data/county_populations.csv';

// locations of original data
const CUMULATIVE_CASES_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_confirmed_usafacts.csv';
const CUMULATIVE_DEATHS_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_deaths_usafacts.csv';
const COUNTY_POPULATIONS_REMOTE = 'https://usafactsstatic.blob.core.windows.net/public/data/covid-19/covid_county_population_usafacts.csv';

// number of milliseconds that cached data is effective for
const ONE_DAY = 1000 * 60 * 60 * 24;
const FOREVER = Number.POSITIVE_INFINITY;

/* display a message and write it to the log file at `LOG_LOC` */
const logMessage = (message) => {
    console.log(message);
    fileSystem.appendFileSync(LOG_LOC, `${message}\n`);
};

/* set up endpoint that mirrors provided remote URL, making use of caching */
const initializeDataEndpoint = (endpoint, remoteURL, cacheLife = ONE_DAY) => {
    let cacheTime;
    let cacheData;
    PROXY.get(`/${endpoint}`, (request, response) => {
        Promise.resolve(
            (async () => {
                response.setHeader('Content-Type', 'text/plain; charset=UTF-8');
                // if cached copy is not outdated, return cached copy
                if (Date.now() - cacheTime < cacheLife) {
                    response.send(cacheData).end();
                    return;
                }
                // if cached copy is outdated, fetch new copy from remote
                // and update cache timestamp
                data = await fetch(remoteURL).then(res => res.text());
                response.send(data).end();
                cacheTime = Date.now();
                cacheData = data;
                logMessage(`[${new Date()}] Fetched from ${remoteURL}`);
                return;
            })()
        ).catch(() => response.sendStatus(500).end());
    });
};

/* set up dataset endpoints */
initializeDataEndpoint(CUMULATIVE_CASES_ENDPOINT, CUMULATIVE_CASES_REMOTE);
initializeDataEndpoint(CUMULATIVE_DEATHS_ENDPOINT, CUMULATIVE_DEATHS_REMOTE);
initializeDataEndpoint(COUNTY_POPULATIONS_ENDPOINT, COUNTY_POPULATIONS_REMOTE,
    FOREVER);

// block access to proxy server logs
PROXY.get(`/${LOG_LOC}`, (req, res) => res.sendStatus(403).end());

// start server
PROXY.listen(PORT, () => {
    logMessage(`[${new Date()}] Server listening on ${PORT}`);
});