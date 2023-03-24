"use strict";

/**
 * Clear RampOnIntervals
 * @param adapter
 * @param Group
 */
async function clearRampOnIntervals(adapter, Group) {
	// log("Reaching ClearRampOnInterval(Group) Group=" + Group);
	if (Group == null) {
		for (const Group in adapter.LightGroups) {
			if (Group === "All") continue;

			if (typeof adapter.RampOnIntervalObject[Group] === "object") {
				adapter.log.debug(`RampOnInterval for Group="${Group} deleted.`);
				adapter.clearInterval(adapter.RampOnIntervalObject[Group]);
			}
		}
	} else {
		if (typeof adapter.RampOnIntervalObject[Group] === "object") {
			adapter.log.debug(`RampOnInterval for Group="${Group} deleted.`);
			adapter.clearInterval(adapter.RampOnIntervalObject[Group]);
		}
	}
}

/**
 * Clear RampOffIntervals
 * @param adapter
 * @param Group
 */
async function clearRampOffIntervals(adapter, Group) {
	// log("Reaching ClearRampOffInterval(Group) Group=" + Group);
	if (Group == null) {
		for (const Group in adapter.LightGroups) {
			if (Group === "All") continue;

			if (typeof adapter.RampOffIntervalObject[Group] === "object") {
				adapter.log.debug(`RampOffInterval for Group="${Group} deleted.`);
				adapter.clearInterval(adapter.RampOffIntervalObject[Group]);
			}
		}
	} else {
		if (typeof adapter.RampOffIntervalObject[Group] === "object") {
			adapter.log.debug(`RampOffInterval for Group="${Group} deleted.`);
			adapter.clearInterval(adapter.RampOffIntervalObject[Group]);
		}
	}
}

/**
 * Clear AutoOffTimeouts
 * @param adapter
 * @param Group
 */
async function clearAutoOffTimeouts(adapter, Group) {
	//  log("Reaching clearAutoOffTimeout(Group) Group=" + Group);
	if (Group === null) {
		for (const Group in adapter.LightGroups) {
			if (Group === "All") continue;

			if (typeof adapter.AutoOffTimeoutObject[Group] === "object") {
				adapter.log.debug(`clearAutoOffTimeout => Timeout for Group="${Group}" deleted.`);
				adapter.clearTimeout(adapter.AutoOffTimeoutObject[Group]);
			}

			if (typeof adapter.AutoOffNoticeTimeoutObject[Group] === "object") {
				adapter.log.debug(`clearAutoOffTimeout => NoticeTimeout for Group="${Group}" deleted.`);
				adapter.clearTimeout(adapter.AutoOffNoticeTimeoutObject[Group]);
			}
		}
	} else {
		if (typeof adapter.AutoOffTimeoutObject[Group] === "object") {
			adapter.log.debug(`clearAutoOffTimeout => Timeout for Group="${Group}" deleted.`);
			adapter.clearTimeout(adapter.AutoOffTimeoutObject[Group]);
		}

		if (typeof adapter.AutoOffNoticeTimeoutObject[Group] === "object") {
			adapter.log.debug(`clearAutoOffTimeout => NoticeTimeout for Group="${Group}" deleted.`);
			adapter.clearTimeout(adapter.AutoOffNoticeTimeoutObject[Group]);
		}
	}
}

/**
 * Clear clearBlinkIntervals
 * @param adapter
 * @param Group
 */
async function clearBlinkIntervals(adapter, Group) {
	if (Group == null) {
		for (const Group in adapter.LightGroups) {
			if (Group === "All") continue;

			if (typeof adapter.BlinkIntervalObj[Group] === "object") {
				adapter.log.debug(`BlinkInterval for Group="${Group}" deleted.`);
				adapter.clearInterval(adapter.BlinkIntervalObj[Group]);
			}
		}
	} else {
		if (typeof adapter.BlinkIntervalObj[Group] == "object") {
			adapter.log.debug(`BlinkInterval for Group="${Group}" deleted.`);
			adapter.clearInterval(adapter.BlinkIntervalObj[Group]);
		}
	}
}

module.exports = {
	clearRampOnIntervals,
	clearRampOffIntervals,
	clearAutoOffTimeouts,
	clearBlinkIntervals,
};
