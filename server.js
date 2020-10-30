const serverCreator = require('express');
const fetch = require('node-fetch');
const fileSystem = require('fs');

const SERVER = serverCreator();
const PORT = 8888;

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

const initializeSmartEndpoint = (cachePath, metaPath, remoteURL) => {
    const UTF_8 = 'utf-8';

    SERVER.get(`/${cachePath}`, async (request, response) => {
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
            console.log(`Fetching new data [${new Date()}]`);
            data = await fetch(remoteURL).then(res => res.text());
            fileSystem.writeFileSync(cachePath, data);
            fileSystem.writeFileSync(metaPath, String(currentTime));
        }
        response.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        response.send(data);
        response.end();
    });
};

initializeSmartEndpoint(CUMULATIVE_CASES_CACHE, CUMULATIVE_CASES_META,
    CUMULATIVE_CASES_REMOTE);
initializeSmartEndpoint(CUMULATIVE_DEATHS_CACHE, CUMULATIVE_DEATHS_META,
    CUMULATIVE_DEATHS_REMOTE);
initializeSmartEndpoint(COUNTY_POPULATIONS_CACHE, COUNTY_POPULATIONS_META,
    COUNTY_POPULATIONS_REMOTE);

SERVER.listen(PORT, () => console.log(`Server listening on ${PORT}`));