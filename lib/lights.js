const filters = {
	useBrightness: (Lights) => Lights.filter((Light) => Light?.bri?.oid && Light?.bri?.useBri),
	simpleLights: (Lights) => Lights.filter((Light) => Light.power?.oid && !Light.bri?.oid),
};

/**
 * Filter Lights array
 * @param {"useBrightness" | "simpleLights"} filterName
 * @param {any} Lights
 */
function getLights(filterName, Lights) {
	const filterFunction = filters[filterName];
	if (filterFunction) {
		return filterFunction(Lights);
	} else {
		return Lights; // Return the array unchanged if the filter name is invalid
	}
}

module.exports = {
	getLights,
};
