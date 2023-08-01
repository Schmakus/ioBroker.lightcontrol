"use strict";
const SunCalc = require("suncalc2");
const { isObject } = require("./tools");

const astroList = [
	"sunrise",
	"sunset",
	"sunriseEnd",
	"sunsetStart",
	"dawn",
	"dusk",
	"nauticalDawn",
	"nauticalDusk",
	"nadir",
	"nightEnd",
	"night",
	"goldenHourEnd",
	"goldenHour",
	"solarNoon",
];
const astroListLow = astroList.map((str) => str.toLowerCase());

/**
 * remove namespace from id
 * @param {string} namespace
 * @param {string} id ID of Datapoint
 */
function removeNamespace(namespace, id) {
	const re = new RegExp(namespace + "*\\.", "g");
	return id.replace(re, "");
}

/**
 * extract Group and Proberty from id
 * @param {string} id ID of Datapoint
 */
function ExtractGroupAndProp(id) {
	const [first, ...rest] = id.split(".");
	return { Group: first, Prop: rest.join(".") };
}

/**
 * checkInput
 * @param adapter
 * @param {string} id Object-ID
 * @param {ioBroker.State} state State
 */
async function CheckInputGeneralAsync(adapter, id, state) {
	try {
		let result = true;

		if (state.val === undefined) {
			// only ack etc. is also possible to acknowledge the current value,
			// if only undefined provided, it should have thrown before
			result = false;
		}

		const obj = await adapter.getObjectAsync(id);

		// for a state object we require common.type to exist
		if (obj.common && obj.common.type) {
			if (state.val !== null) {
				if (obj.common.type !== typeof state.val) {
					result = false;
				}

				//check min/max if it's a number
				if (typeof state.val === "number") {
					if (obj.common.max !== undefined && state.val > obj.common.max) {
						result = false;
					}

					if (obj.common.min !== undefined && state.val < obj.common.min) {
						result = false;
					}
				}
			}
		} else {
			adapter.log.warn(`Object of state "${id}" is missing the required property "common.type"`);
			result = false;
		}

		return result;
	} catch (e) {
		adapter.log.error(`Could not perform strict object check of state ${id}: ${e.message}`);
	}
}

/**
 * checkHEX
 * @param {string} hex HEX String beginning with '#' and 3-6 characters
 */
function CheckHex(hex) {
	const rex = /^#[0-9A-Fa-f]{3,6}$/g;
	return rex.test(hex);
}

/**
 * getParentById
 * Find direkt Name of Object-ID
 * @param {object} object LightGroups Object
 * @param {string} id
 */
async function getParentById(object, id) {
	return Object.keys(object).find((key) => Object.values(object[key]).indexOf(id) > -1);
}

/**
 * getGroupById
 * Find direkt Group of Object-ID
 * @param {object} object LightGroups Object
 * @param {string} id
 */
function getGroupById(object, id) {
	return Object.keys(object).find((key) => Object.values(object[key]).indexOf(id) > -2);
}

/**
 * @description Check if number is negativ
 * @param {number} num Number
 */
function isNegative(num) {
	if (Math.sign(num) === -1) {
		return true;
	}

	return false;
}

/**
 * @description Remove Value from Array
 * @param {Array} arr
 * @param {string} value
 */
function removeValue(arr, value) {
	return arr.filter(function (ele) {
		return ele != value;
	});
}

/**
 *
 * @param {object} adapter
 * @param {string} pattern
 * @param {string | number | undefined | object} date
 * @param {number} offsetMinutes
 */
function getAstroDate(adapter, pattern, date, offsetMinutes = 0) {
	try {
		if (date === undefined) {
			date = new Date();
		}
		if (typeof date === "number") {
			date = new Date(date);
		}

		if ((!adapter.lat && adapter.lat !== 0) || (!adapter.lng && adapter.lng !== 0)) {
			adapter.writeLog("[ getAstroDate ] Longitude or latitude does not set. Cannot use astro.", "warn");
			return 0;
		}
		// ensure events are calculated independent of current time
		date.setHours(12, 0, 0, 0);
		let ts = SunCalc.getTimes(date, adapter.lat, adapter.lng)[pattern];

		if (ts === undefined || ts.getTime().toString() === "NaN") {
			adapter.writeLog(`[ getAstroDate ] Cannot get astro date for "${pattern}"`, "error");
		}

		adapter.writeLog(`[ getAstroDate ]  getAstroDate(pattern=${pattern}, date=${date}) => ${ts}`);

		if (offsetMinutes !== undefined) {
			ts = new Date(ts.getTime() + offsetMinutes * 60000);
		}
		return ts;
	} catch (error) {
		adapter.errorHandling(error, "getAstroDate");
	}
}

function compareTime(adapter, startTime, endTime, operation, time) {
	let pos;
	if (startTime && typeof startTime === "string") {
		if ((pos = astroListLow.indexOf(startTime.toLowerCase())) !== -1) {
			startTime = getAstroDate(adapter, astroList[pos], undefined);
			startTime = startTime.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
		}
	} else if (startTime && isObject(startTime) && startTime.astro) {
		startTime = getAstroDate(adapter, startTime.astro, startTime.date || new Date(), startTime.offset || 0);
		startTime = startTime.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	}
	if (endTime && typeof endTime === "string") {
		if ((pos = astroListLow.indexOf(endTime.toLowerCase())) !== -1) {
			endTime = getAstroDate(adapter, astroList[pos], undefined);
			endTime = endTime.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
		}
	} else if (endTime && isObject(endTime) && endTime.astro) {
		endTime = getAstroDate(adapter, endTime.astro, endTime.date || new Date(), endTime.offset || 0);
		endTime = endTime.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	}
	if (time && typeof time === "string") {
		if ((pos = astroListLow.indexOf(time.toLowerCase())) !== -1) {
			time = getAstroDate(adapter, astroList[pos], undefined);
		}
	} else if (time && isObject(time) && time.astro) {
		time = getAstroDate(adapter, time.astro, time.date || new Date(), time.offset || 0);
	}

	let daily = true;
	if (time) {
		daily = false;
	}
	if (time && !isObject(time)) {
		if (typeof time === "string" && !time.includes(" ") && !time.includes("T")) {
			const parts = time.split(":");
			time = new Date();
			time.setHours(parseInt(parts[0], 10));
			time.setMinutes(parseInt(parts[1], 10));
			time.setMilliseconds(0);

			if (parts.length === 3) {
				time.setSeconds(parseInt(parts[2], 10));
			} else {
				time.setSeconds(0);
			}
		} else {
			time = new Date(time);
		}
	} else if (!time) {
		time = new Date();
		time.setMilliseconds(0);
	}

	if (typeof startTime === "string") {
		if (!startTime.includes(" ") && !startTime.includes("T")) {
			const parts = startTime.split(":");
			startTime = new Date();
			startTime.setHours(parseInt(parts[0], 10));
			startTime.setMinutes(parseInt(parts[1], 10));
			startTime.setMilliseconds(0);

			if (parts.length === 3) {
				startTime.setSeconds(parseInt(parts[2], 10));
			} else {
				startTime.setSeconds(0);
			}
		} else {
			daily = false;
			startTime = new Date(startTime);
		}
	} else {
		daily = false;
		startTime = new Date(startTime);
	}
	startTime = startTime.getTime();

	if (endTime && typeof endTime === "string") {
		if (!endTime.includes(" ") && !endTime.includes("T")) {
			const parts = endTime.split(":");
			endTime = new Date();
			endTime.setHours(parseInt(parts[0], 10));
			endTime.setMinutes(parseInt(parts[1], 10));
			endTime.setMilliseconds(0);

			if (parts.length === 3) {
				endTime.setSeconds(parseInt(parts[2], 10));
			} else {
				endTime.setSeconds(0);
			}
		} else {
			daily = false;
			endTime = new Date(endTime);
		}
	} else if (endTime) {
		daily = false;
		endTime = new Date(endTime);
	} else {
		endTime = null;
	}

	if (endTime) {
		endTime = endTime.getTime();
	}

	if (operation === "between") {
		if (endTime) {
			if (typeof time === "object") {
				time = time.getTime();
			}
			if (typeof startTime === "object") {
				startTime = startTime.getTime();
			}
			if (typeof endTime === "object") {
				endTime = endTime.getTime();
			}

			if (startTime > endTime && daily) {
				return !(time >= endTime && time < startTime);
			} else {
				return time >= startTime && time < endTime;
			}
		} else {
			adapter.writeLog("[ compareTime ] missing or unrecognized endTime expression: " + endTime, "warn");
			return false;
		}
	} else if (operation === "not between") {
		if (endTime) {
			if (typeof time === "object") {
				time = time.getTime();
			}
			if (typeof startTime === "object") {
				startTime = startTime.getTime();
			}
			if (typeof endTime === "object") {
				endTime = endTime.getTime();
			}
			if (startTime > endTime && daily) {
				return time >= endTime && time < startTime;
			} else {
				return !(time >= startTime && time < endTime);
			}
		} else {
			adapter.writeLog("[ compareTime ] missing or unrecognized endTime expression: " + endTime), "warn";
			return false;
		}
	} else {
		if (typeof time === "object") {
			time = time.getTime();
		}
		if (typeof startTime === "object") {
			startTime = startTime.getTime();
		}

		if (operation === ">") {
			return time > startTime;
		} else if (operation === ">=") {
			return time >= startTime;
		} else if (operation === "<") {
			return time < startTime;
		} else if (operation === "<=") {
			return time <= startTime;
		} else if (operation === "==") {
			return time === startTime;
		} else if (operation === "<>") {
			return time !== startTime;
		} else {
			adapter.writeLog("[ compareTime ] Invalid operator: " + operation, "warn");
			return false;
		}
	}
}

function getDateObject(date) {
	if (isObject(date)) return date;
	if (typeof date !== "string") return new Date(date);
	if (date.match(/^\d?\d$/)) {
		const _now = new Date();
		date = `${_now.getFullYear()}-${_now.getMonth() + 1}-${_now.getDate()} ${date}:00`;
	} else {
		// 20:00, 2:00, 20:00:00, 2:00:00
		if (date.match(/^\d?\d:\d\d(:\d\d)?$/)) {
			const now = new Date();
			date = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${date}`;
		}
	}
	return new Date(date);
}

/**
 * Begrenzt die Eingabezahl auf einen bestimmten Bereich und gibt eine neue Zahl zurück.
 * @async
 * @param {number} input - Die Eingabezahl, die begrenzt werden soll.
 * @param {number} min - Der kleinste Wert, den die Eingabezahl haben kann.
 * @param {number} max - Der größte Wert, den die Eingabezahl haben kann.
 * @example
 * const result = await limitNumber(10, 0, 5);
 * console.log(result); // Output: 5
 */
function limitNumber(input, min = 0, max = 64000) {
	const limitedNum = Math.max(min, Math.min(input, max));
	if (isNaN(limitedNum)) {
		return 0;
	}
	return limitedNum;
}

/**
 * Konvertiert die angegebene Zeit basierend auf der Einheit in Sekunden, Millisekunden oder dezisekunden.
 * @param {string} unit - Die Einheit der Zeit (s, ms, ds).
 * @param {number} time - Die Zeit in Millisekunden.
 * @throws {Error} - Wenn eine ungültige Einheit angegeben wurde.
 */
function convertTime(unit, time) {
	let result;

	switch (unit) {
		case "s":
			result = time / 1000;
			break;
		case "ms":
			result = time;
			break;
		case "ds":
			result = time / 100;
			break;
		default:
			result = time;
	}
	return result;
}

function checkObjectNumber(obj) {
	if (!obj || obj.val === "" || obj.val === null || typeof obj.val !== "number" || isNaN(obj.val)) {
		return null;
	} else {
		return obj.val;
	}
}

function checkObjectBoolean(obj) {
	if (!obj || obj.val === "" || obj.val === null || typeof obj.val !== "boolean") {
		return null;
	} else {
		return obj.val;
	}
}

/*
/**
 * Vergleicht objMemory mit objInstanz auf fehlende key/value paare
 * @param {object} objA ObjectView der Instanz
 * @param {object} objB Object LightGroups
 * @returns {Array} Das formatierte Ergebnis des Vergleichs.
 */
function compareAndFormatObjects(objA, objB) {
	/**
	 * Vergleicht zwei Objekte und gibt die fehlenden Schlüsselwertpaare zurück.
	 * @param {Object} objA - ObjectView der Instanz
	 * @param {Object} objB - Object LightGroups
	 * @param {string} [parentKey=""] - Der Elternschlüssel.
	 * @returns {Array} Die fehlenden Schlüsselwertpaare.
	 */
	function compareObjects(objA, objB, parentKey = "") {
		// Überprüfen, ob ObjA und ObjB Objekte sind
		if (
			typeof objA !== "object" ||
			typeof objB !== "object" ||
			objA === null ||
			objB === null ||
			Array.isArray(objA) ||
			Array.isArray(objB)
		) {
			return [];
		}

		const missingPairs = [];

		// Durchlaufe alle key/value-Paare in ObjA
		for (const key in objA) {
			// Erstelle den vollständigen Schlüssel einschließlich des Elternschlüssels
			const fullKey = parentKey ? `${parentKey}.${key}` : key;

			// Überprüfen, ob das aktuelle key/value-Paar in ObjB vorhanden ist
			if (!(key in objB)) {
				missingPairs.push({ key: fullKey, target: objA[key], actual: undefined });
			} else {
				// Überprüfen, ob die Werte der key/value-Paare übereinstimmen
				if (typeof objA[key] === "object") {
					// Wenn der Wert ein weiteres Objekt ist, rekursiv den Vergleich durchführen
					const subMissingPairs = compareObjects(objA[key], objB[key], fullKey);
					if (subMissingPairs.length > 0) {
						missingPairs.push({ key: fullKey, values: subMissingPairs });
					}
				} else {
					// Wenn der Wert ein skalares Datum ist, direkten Vergleich durchführen
					if (objA[key] !== objB[key]) {
						missingPairs.push({ key: fullKey, target: objA[key], actual: objB[key] });
					}
				}
			}
		}

		return missingPairs;
	}

	/**
	 * Formatiert das Ergebnis des Vergleichs.
	 * @param {Array} result - Das Ergebnis des Vergleichs.
	 * @param {string} [parentKey=""] - Der Elternschlüssel.
	 * @returns {Array} Das formatierte Ergebnis.
	 */
	function formatOutput(result, parentKey = "") {
		const formattedResult = [];

		for (const item of result) {
			if (item.values) {
				const subResult = formatOutput(item.values, item.key);
				if (subResult.length === 1 && subResult[0].key) {
					formattedResult.push(subResult[0]);
				} else {
					formattedResult.push({
						Group: item.key,
						values: subResult,
					});
				}
			} else {
				if (!item.actual) {
					formattedResult.push({
						info: "key not exist",
						key: item.key,
					});
				} else {
					formattedResult.push({
						info: "current value does not correspond to target value",
						Group: parentKey.split(".")[0],
						key: item.key,
						target: item.target,
						actual: item.actual,
					});
				}
			}
		}

		return formattedResult;
	}

	const result = compareObjects(objA, objB);
	const formattedResult = formatOutput(result);
	return formattedResult;
}

/**
 * KelvinToRange
 * @param {object} adapter	Adapter-Class
 * @param {number} outMinVal	minimum Ct-Value of target state
 * @param {number} outMaxVal	maximum Ct-Value of target state
 * @param {number} minKelvin minimum kelvin value
 * @param {number} maxKelvin maximum kelvin value
 * @param {number} kelvin	kelvin value of group (e.g. 2700)
 * @param {string} ctConversion	switch if lower ct-value is cold
 * @returns {Promise<number>} return the Ct-Value of the target state
 */
async function KelvinToRange(adapter, outMinVal, outMaxVal, minKelvin, maxKelvin, kelvin, ctConversion) {
	try {
		adapter.writeLog(
			`[ KelvinToRange ] outMinVal: ${outMinVal}, outMaxVal: ${outMaxVal}, minKelvin: ${minKelvin}, maxKelvin: ${maxKelvin}, kelvin: ${kelvin}, ctConversion: ${ctConversion}`,
		);

		let rangeValue;
		let limitedKelvin;

		switch (ctConversion) {
			case "default":
				return -2;
			case "warmToCool":
				limitedKelvin = Math.max(Math.min(kelvin, maxKelvin), minKelvin);
				rangeValue =
					((limitedKelvin - minKelvin) / (maxKelvin - minKelvin)) * (outMaxVal - outMinVal) + outMinVal;
				adapter.writeLog(`[ KelvinToRange ] Calculated ct-value (warmToCool): ${rangeValue}`);
				return rangeValue;
			case "coolToWarm":
				limitedKelvin = Math.max(Math.min(kelvin, minKelvin), maxKelvin);
				rangeValue =
					((limitedKelvin - minKelvin) / (maxKelvin - minKelvin)) * (outMaxVal - outMinVal) + outMinVal;
				adapter.writeLog(`[ KelvinToRange ] Calculated ct-value (coolToWarm): ${rangeValue}`);
				return rangeValue;
			case "mired":
				rangeValue = Math.floor(1000000 / kelvin);
				rangeValue = Math.max(Math.min(rangeValue, outMaxVal), outMinVal);
				adapter.writeLog(`[ KelvinToRange ] Calculated ct-value (mired): ${rangeValue}`);
				return rangeValue;
			default:
				return -3;
		}
	} catch (error) {
		adapter.errorHandling(
			error,
			"KelvinToRange",
			`kelvin: ${kelvin}, outMaxCt: ${outMaxVal}, outMinCt: ${outMinVal}`,
		);
		return -1;
	}
}

function createNestedObject(namespace, data) {
	const nestedObject = {};

	for (const key in data) {
		if (key.startsWith("lightcontrol.0.")) {
			const modifiedKey = key.replace(`${namespace}.`, "");
			const value = data[key].type === "state" ? data[key].common.def : createNestedObject(data[key]);
			const keyParts = modifiedKey.split(".");
			let currentObject = nestedObject;

			for (let i = 0; i < keyParts.length; i++) {
				const keyPart = keyParts[i];
				if (!Object.prototype.hasOwnProperty.call(currentObject, keyPart)) {
					currentObject[keyPart] = {};
				}
				if (i === keyParts.length - 1) {
					currentObject[keyPart] = value;
				} else {
					currentObject = currentObject[keyPart];
				}
			}
		}
	}

	return nestedObject;
}

module.exports = {
	removeNamespace,
	CheckInputGeneralAsync,
	CheckHex,
	ExtractGroupAndProp,
	getGroupById,
	getParentById,
	isNegative,
	removeValue,
	getAstroDate,
	compareTime,
	getDateObject,
	limitNumber,
	convertTime,
	checkObjectNumber,
	checkObjectBoolean,
	compareAndFormatObjects,
	KelvinToRange,
	createNestedObject,
};