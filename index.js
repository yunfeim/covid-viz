const loadMap = (mapLocation = './usa_counties.svg') => {
    fetch(mapLocation).then(res => res.text()).then(raw => {
        const parser = new DOMParser();
        const XMLTree = parser.parseFromString(raw, "image/svg+xml");
        const asNode = document.adoptNode(XMLTree.querySelector('svg'));
        document.getElementById('viz').replaceWith(asNode);
    });
};

loadMap();