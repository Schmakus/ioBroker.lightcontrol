"use strict";
/**
 * Tests whether the given variable is a real object and not an Array
 * @param {any} it The variable to test
 * @returns {it is Record<string, any>}
 */
function isObject(it) {
	// This is necessary because:
	// typeof null === 'object'
	// typeof [] === 'object'
	// [] instanceof Object === true
	return Object.prototype.toString.call(it) === "[object Object]";
}

/**
 * Tests whether the given variable is really an Array
 * @param {any} it The variable to test
 * @returns {it is any[]}
 */
function isArray(it) {
	if (typeof Array.isArray === "function") return Array.isArray(it);
	return Object.prototype.toString.call(it) === "[object Array]";
}

/**
 * checkInput
 * @param {string} id Object-ID
 * @param {ioBroker.State} state State
 * @this {object}
 */
async function CheckInputGeneralAsync(id, state) {
	try {
		let result = true;

		if (state.val === undefined) {
			// only ack etc. is also possible to acknowledge the current value,
			// if only undefined provided, it should have thrown before
			result = false;
		}

		const obj = await this.getObjectAsync(id);

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
			this.log.warn(`Object of state "${id}" is missing the required property "common.type"`);
			result = false;
		}

		return result;
	} catch (e) {
		this.log.error(`Could not perform strict object check of state ${id}: ${e.message}`);
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
 * @description Check if number is negativ
 * @param {number} num Number
 */
function isNegative(num) {
	if (Math.sign(num) === -1) {
		return true;
	}

	return false;
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

module.exports = {
	CheckInputGeneralAsync,
	CheckHex,
	isNegative,
	checkObjectNumber,
	checkObjectBoolean,
	isArray,
	isObject,
};
