"use strict";

/**
 * RefreshGenericLuxValues
 * @param adapter
 */
async function RefreshGenericLuxValues(adapter) {
	// Used by Init - refreshing ALL Groups using the generic Luxsensor with new value
	try {
		const LightGroups = adapter.LightGroups;
		adapter.log.debug("Reaching RefreshGenericLuxValues");

		for (const Group in LightGroups) {
			//Check if global LuxSesnor available
			if (
				LightGroups[Group].LuxSensor !== "" &&
				LightGroups[Group].LuxSensor == adapter.GlobalSettings.GlobalLuxSensor
			) {
				LightGroups[Group].actualLux = adapter.ActualGenericLux;
				adapter.Controller(Group, "actualLux", LightGroups[Group].actualLux, adapter.ActualGenericLux);
			}
		}
	} catch (e) {
		adapter.log.warn(`RefreshGenericLuxValues => ${e}`);
	}
}

module.exports = {
	RefreshGenericLuxValues,
};
