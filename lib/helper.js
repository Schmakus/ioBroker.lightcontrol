"use strict";

/**
 * Set Values and Keys to Object
 * @function SetValueToObject
 * @author Schmakus https://github.com/Schmakus
 * @param {object} Group The Object to set
 * @param {string|array} keys path to the value
 * @param {any} value value to set
 * @returns {Promise} new Object
 */
async function SetValueToObject(Group, keys, value) {
	if (Array.isArray(keys)) {
		for (const key of keys) {
			const prop = key.split(".");
			await set(Group, prop, value);
		}
	} else {
		const prop = keys.split(".");
		await set(Group, prop, value);
	}

	async function set(Group, prop, value) {
		switch (prop.length) {
			case 1:
				Group[prop[0]] = value;
				break;
			case 2:
				Group[prop[0]] = Group[prop[0]] || {};
				Group[prop[0]][prop[1]] = value;
				break;
			case 3:
				Group[prop[0]] = Group[prop[0]] || {};
				Group[prop[0]][prop[1]] = Group[prop[0]][prop[1]] || {};
				Group[prop[0]][prop[1]][prop[2]] = value;
				break;
			case 4:
				Group[prop[0]] = Group[prop[0]] || {};
				Group[prop[0]][prop[1]] = Group[prop[0]][prop[1]] || {};
				Group[prop[0]][prop[1]][prop[2]] = Group[prop[0]][prop[1]][prop[2]] || {};
				Group[prop[0]][prop[1]][prop[2]][prop[3]] = value;
				break;
		}
	}
	return Group;
}

/**
 * remove namespace from id
 * @param {string} id ID of Datapoint
 */
async function removeNamespace(adapter, id) {
	const re = new RegExp(adapter.namespace + "*\\.", "g");
	return id.replace(re, "");
}

/**
 * extract Group and Proberty from id
 * @param {string} id ID of Datapoint
 */
async function ExtractGroupAndProp(id) {
	const [first, ...rest] = id.split(".");
	return { Group: first, Prop: rest.join(".") };
}

/**
 * checkInput
 * @param adapter
 * @param {string} id Object-ID
 * @param {ioBroker.State} state State
 */
async function CheckInputGeneral(adapter, id, state) {
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
async function CheckHex(hex) {
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
async function getGroupById(object, id) {
	return Object.keys(object).find((key) => Object.values(object[key]).indexOf(id) > -2);
}

/**
 * @description Check if number is negativ
 * @param {number} num Number
 */
async function isNegative(num) {
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
async function removeValue(arr, value) {
	return arr.filter(function (ele) {
		return ele != value;
	});
}

module.exports = {
	SetValueToObject,
	removeNamespace,
	CheckInputGeneral,
	CheckHex,
	ExtractGroupAndProp,
	getGroupById,
	getParentById,
	isNegative,
	removeValue,
};
