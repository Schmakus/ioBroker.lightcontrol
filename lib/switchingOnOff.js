"use strict";

const { clearAutoOffTimeouts, clearRampOnIntervals, clearRampOffIntervals, clearBlinkIntervals } = require("./timers");
const {
	setDeviceBri,
	SetWhiteSubstituteColor,
	PowerOnAftercare,
	SetBrightness,
	SetColor,
	AdaptiveBri,
	SetCt,
} = require("./lightHandling");
const { SetValueToObject } = require("./helper");

/**
 * SimpleGroupPowerOnOff
 * @param {Object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function SimpleGroupPowerOnOff(adapter, Group, OnOff) {
	const LightGroups = adapter.LightGroups;
	const operation = OnOff ? "on" : "off";
	try {
		if (!LightGroups[Group].lights?.length) {
			adapter.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const outlast = OutlastDevices(adapter, LightGroups[Group].lights, OnOff);
		const useSwitch = BrightnessDevicesSwitchPower(adapter, LightGroups[Group].lights, OnOff);

		const useBrightness = LightGroups[Group].lights
			.filter((Light) => Light?.bri?.oid && Light?.bri?.useBri)
			.map(async (Light) => {
				const brightness = LightGroups[Group].adaptiveBri
					? await AdaptiveBri(adapter, Group)
					: adapter.LightGroups[Group].bri;

				await Promise.all([
					setDeviceBri(adapter, Light, OnOff ? brightness : 0),
					adapter.writeLog(
						`[ SimpleGroupPowerOnOff ] Switching ${operation} ${Light.description} (${Light.bri.oid}) with brightness state`,
					),
				]);
			});

		await Promise.all([useBrightness, useSwitch, outlast]);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "SimpleGroupPowerOnOff");
	}
}

/**
 * GroupPowerOnOff
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function GroupPowerOnOff(adapter, Group, OnOff) {
	const LightGroups = adapter.LightGroups;
	try {
		adapter.writeLog(
			`[ GroupPowerOnOff ] Reaching for Group="${Group}", OnOff="${OnOff}" rampOn="${
				LightGroups[Group].rampOn.enabled
			}" - ${JSON.stringify(LightGroups[Group].rampOn)} rampOff="${
				LightGroups[Group].rampOff.enabled
			}" - ${JSON.stringify(LightGroups[Group].rampOff)}`,
		);

		if (!LightGroups[Group].lights.some((Light) => Light.power?.oid || Light.bri?.oid)) {
			await adapter.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching ${OnOff} for Group = "${Group}". No lights defined or no power or brightness states are defined!!`,
				"warn",
			);
			return;
		}

		if (OnOff) {
			LightGroups[Group].power = true;
			//
			// ******* Anschalten ohne ramping * //
			//
			if (!LightGroups[Group].rampOn.enabled) {
				await SimpleGroupPowerOnOff(adapter, Group, OnOff);

				if (LightGroups[Group].autoOffTimed.enabled) {
					//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
					await AutoOffTimed(adapter, Group);
				}
			} else {
				await TurnOnWithRamping(adapter, Group);
			}
		} else {
			// Ausschalten ohne Ramping */
			if (!LightGroups[Group].rampOff.enabled) {
				if (LightGroups[Group].rampOn.enabled) {
					//Vor dem ausschalten Helligkeit auf 2 (0+1 wird bei manchchen Devices als aus gewertet) um bei rampon nicht mit voller Pulle zu starten
					await SetBrightness(adapter, Group, 2, "ramping");
				}

				await SimpleGroupPowerOnOff(adapter, Group, OnOff);
				LightGroups[Group].power = false;
			} else {
				// Ausschalten mit Ramping */
				await TurnOffWithRamping(adapter, Group);
			}
		}

		await Promise.all([
			adapter.setStateAsync(Group + ".power", OnOff, true),
			adapter.SetLightState("GroupPowerOnOff"),
		]);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "GroupPowerOnOff");
	}
}

/**
 * DeviceSwitch simple lights with no brightness state
 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function DeviceSwitch(adapter, Group, OnOff) {
	try {
		adapter.writeLog(`[ DeviceSwitch ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

		const LightGroups = adapter.LightGroups;

		const promises = LightGroups[Group].lights.map(async (Light) => {
			if (!Light?.bri?.oid && Light?.power?.oid) {
				await Promise.all([
					adapter.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
					adapter.writeLog(
						`[ DeviceSwitch ] Switching ${Light.description} (${Light.power.oid}) to: ${OnOff}`,
					),
				]);
			}
		});

		await Promise.all(promises);
	} catch (error) {
		adapter.errorHandling(error, "DeviceSwitch");
	}
}

/**
 * DeviceSwitch lights before ramping (if brightness state available and not use Bri for ramping)
 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function DeviceSwitchForRamping(adapter, Group, OnOff) {
	try {
		adapter.writeLog(`[ DeviceSwitchForRamping ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

		const LightGroups = adapter.LightGroups;

		const promises = LightGroups[Group].lights.map(async (Light) => {
			//prüfen ob Helligkeitsdatenpunkt vorhanden UND useBri = false
			if (Light?.bri?.oid && !Light?.bri?.useBri && Light?.power?.oid) {
				await adapter.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
			}
		});
		await Promise.all(promises);
	} catch (error) {
		adapter.errorHandling(error, "DeviceSwitchForRamping");
	}
}

/**
 * OutlastDevices simple lights with no brightness state
 * @description Switch simple lights with no brightness state
 * @async
 * @function
 * @param {object} adapter Adapter-Class
 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function OutlastDevices(adapter, Lights, OnOff) {
	try {
		return Lights.filter((Light) => Light.power?.oid && !Light.bri?.oid).map(async (Light) => {
			await Promise.all([
				adapter.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
				adapter.writeLog(
					`[ DOutlastDevices ] Switching ${Light.description} (${Light.power.oid}) to: ${OnOff}`,
				),
			]);
		});
	} catch (error) {
		adapter.errorHandling(error, "OutlastDevices");
	}
}

/**
 * BrightnessDevicesSwitchPower
 * @description Switch lights before ramping (if brightness state available and not use Bri for ramping)
 * @async
 * @function
 * @param {object} adapter Adapter-Class
 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function BrightnessDevicesSwitchPower(adapter, Lights, OnOff) {
	try {
		return Lights.filter((Light) => Light.power?.oid && Light.bri?.oid && !Light.bri?.useBri).map(async (Light) => {
			await Promise.all([
				adapter.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
				adapter.writeLog(
					`[ BrightnessDevicesSwitchPower ] Switching ${Light.description} (${Light.bri.oid}) to: ${OnOff}`,
				),
			]);
		});
	} catch (error) {
		adapter.errorHandling(error, "BrightnessDevicesSwitchPower");
	}
}

/**
 * BrightnessDevicesWithoutRampTime
 * @description Switch lights before ramping (if brightness state available and not use Bri for ramping)
 * @async
 * @function
 * @param {object} adapter Adapter-Class
 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number} Brightness true/false from power state
 */
/*
async function BrightnessDevicesWithoutRampTime(adapter, Lights, Brightness) {
	try {
		return Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && !Light.tt?.useTt).map(async (Light) => {
			await Promise.all([
				adapter.setForeignStateAsync(Light.bri.oid, Brightness),
				adapter.writeLog(
					`[ BrightnessDevicesWithoutRampTime ] Set ${Light.description} (${Light.bri.oid}) to: ${Brightness}`,
				),
			]);
		});
	} catch (error) {
		adapter.errorHandling(error, "BrightnessDevicesWithoutRampTime");
	}
}
*/

/**
 * BrightnessDevicesWithRampTime
 * @description Set Brighness to Lights with Transmission time
 * @async
 * @function
 * @param {object} adapter Adapter-Class
 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} Brightness true/false from power state
 * @param {number} RampTime Information about the RampTime
 */
/*
async function BrightnessDevicesWithRampTime(adapter, Lights, Brightness, RampTime) {
	try {
		return Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && Light.tt?.useTt).map(async (Light) => {
			await Promise.all([
				adapter.setForeignStateAsync(Light.bri.oid, Brightness),
				adapter.writeLog(
					`[ BrightnessDevicesWithRampTime ] Set ${Light.description} (${Light.bri.oid}) to: ${Brightness} in: ${RampTime}`,
				),
			]);
		});
	} catch (error) {
		adapter.errorHandling(error, "BrightnessDevicesWithRampTime");
	}
}
*/

/**
 * TurnOnWithRamping
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @returns {Promise<Boolean>} Ein Promise-Objekt, das ein Boolean zurückgibt.
 */
async function TurnOnWithRamping(adapter, Group) {
	const LightGroups = adapter.LightGroups;
	const RampSteps = adapter.GlobalSettings.RampSteps;
	let LoopCount = 0;
	//
	// ******* Anschalten mit ramping * //
	//
	if (LightGroups[Group].rampOn.enabled && LightGroups[Group].rampOn.switchOutletsLast) {
		adapter.writeLog(`[ GroupPowerOnOff ] Switch off with ramping and simple lamps last for Group="${Group}"`);

		await clearRampOnIntervals(adapter, Group);
		await BrightnessDevicesSwitchPower(adapter, LightGroups[Group].lights, true);

		adapter.RampOnIntervalObject[Group] = setInterval(async function () {
			LoopCount++;

			// Helligkeit erhöhen
			await SetBrightness(
				adapter,
				Group,
				Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)),
				"ramping",
			);

			//Interval stoppen und einfache Lampen schalten
			if (LoopCount >= RampSteps) {
				await DeviceSwitch(adapter, Group, true); // Einfache Lampen

				if (LightGroups[Group].autoOffTimed.enabled) {
					//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
					await AutoOffTimed(adapter, Group);
				}

				await clearRampOnIntervals(adapter, Group);
			}
		}, Math.round(LightGroups[Group].rampOn.time / RampSteps) * 1000);
	} else if (LightGroups[Group].rampOn.enabled && !LightGroups[Group].rampOn.switchOutletsLast) {
		//Anschalten mit Ramping und einfache Lampen zuerst

		adapter.writeLog(`[ GroupPowerOnOff ] Anschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

		await clearRampOnIntervals(adapter, Group);
		await DeviceSwitch(adapter, Group, true); // Einfache Lampen
		await DeviceSwitchForRamping(adapter, Group, true); //Restliche Lampen

		// Interval starten
		adapter.RampOnIntervalObject[Group] = setInterval(async function () {
			// Helligkeit erhöhen
			await SetBrightness(
				adapter,
				Group,
				Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)),
				"ramping",
			);

			LoopCount++;

			// Intervall stoppen
			if (LoopCount >= RampSteps) {
				if (LightGroups[Group].autoOffTimed.enabled) {
					//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

					await AutoOffTimed(adapter, Group);
				}

				await clearRampOnIntervals(adapter, Group);
			}
		}, Math.round(LightGroups[Group].rampOn.time / RampSteps) * 1000);
	}
	return true;
}

/**
 * TurnOffWithRamping
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function TurnOffWithRamping(adapter, Group) {
	const LightGroups = adapter.LightGroups;
	const RampSteps = adapter.GlobalSettings.RampSteps;
	let LoopCount = 0;

	//
	//******* Ausschalten mit Ramping */
	//
	if (LightGroups[Group].rampOff.enabled && LightGroups[Group].rampOff.switchOutletsLast) {
		////Ausschalten mit Ramping und einfache Lampen zuletzt

		adapter.writeLog(
			`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuletzt für Group="${Group}"`,
		);

		await clearRampOffIntervals(adapter, Group);

		// Interval starten
		adapter.RampOffIntervalObject[Group] = setInterval(async function () {
			// Helligkeit veringern
			await SetBrightness(
				adapter,
				Group,
				LightGroups[Group].bri -
					LightGroups[Group].bri / RampSteps -
					Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)),
				"ramping",
			);

			LoopCount++;

			// Intervall stoppen
			if (LoopCount >= RampSteps) {
				await clearRampOffIntervals(adapter, Group);
				await DeviceSwitchForRamping(adapter, Group, false); //restliche Lampen
				await DeviceSwitch(adapter, Group, false); // einfache Lampen
				LightGroups[Group].power = false;
				adapter.writeLog(`Result of TurnOffWithRamping: ${LightGroups[Group].power}`);
			}
		}, Math.round(LightGroups[Group].rampOff.time / RampSteps) * 1000);
	} else if (LightGroups[Group].rampOff.enabled && !LightGroups[Group].rampOff.switchOutletsLast) {
		////Ausschalten mit Ramping und einfache Lampen zuerst

		adapter.writeLog(`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

		//Ausschalten von Lampen, welche keinen Brighness State haben

		await clearRampOffIntervals(adapter, Group);
		await DeviceSwitch(adapter, Group, false); // einfache Lampen

		// Intervall starten
		adapter.RampOffIntervalObject[Group] = setInterval(async function () {
			await SetBrightness(
				adapter,
				Group,
				LightGroups[Group].bri -
					LightGroups[Group].bri / RampSteps -
					Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)),
				"ramping",
			);

			LoopCount++;
			// Intervall stoppen
			if (LoopCount >= RampSteps) {
				await DeviceSwitchForRamping(adapter, Group, false); // restliche Lampen
				await clearRampOffIntervals(adapter, Group);
				LightGroups[Group].power = false;
				adapter.writeLog(`Result of TurnOffWithRamping: ${LightGroups[Group].power}`);
			}
		}, Math.round(LightGroups[Group].rampOff.time / RampSteps) * 1000);
	}
}

/**
 * GroupPowerCleaningLightOnOff
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function GroupPowerCleaningLightOnOff(adapter, Group, OnOff) {
	const LightGroups = adapter.LightGroups;
	const funcName = "GroupPowerCleaningLightOnOff";
	try {
		adapter.writeLog(`[ ${funcName} ] Reaching GroupPowerCleaningLightOnOff for Group="${Group}, OnOff="${OnOff}"`);

		await clearAutoOffTimeouts(adapter, Group);

		if (OnOff) {
			if (LightGroups[Group].power) {
				await Promise.all([
					SetBrightness(adapter, Group, 100),
					SetCt(adapter, Group, adapter.Settings.maxCt || 6500),
				]);
				LightGroups[Group].lastPower = true;
			} else {
				adapter.LightGroups[Group].power = true;
				adapter.LightGroups[Group].lastPower = false;
				await SimpleGroupPowerOnOff(adapter, Group, true);
				await Promise.all([
					SetBrightness(adapter, Group, 100),
					SetCt(adapter, Group, adapter.Settings.maxCt || 6500),
					adapter.setStateAsync(Group + ".power", true, true),
				]);
			}
		} else {
			const brightness = LightGroups[Group].adaptiveBri
				? await AdaptiveBri(adapter, Group)
				: LightGroups[Group].bri;

			await Promise.all([
				SetBrightness(adapter, Group, brightness),
				SetCt(adapter, Group, LightGroups[Group].ct),
			]);

			if (!LightGroups[Group].lastPower) {
				LightGroups[Group].power = false;
				await Promise.all([
					SimpleGroupPowerOnOff(adapter, Group, false),
					adapter.setStateAsync(Group + ".power", false, true),
				]);
			}
		}

		await adapter.setStateAsync(Group + ".powerCleaningLight", OnOff, true);
	} catch (error) {
		adapter.errorHandling(error, funcName, `Group="${Group}"`);
	}
}

/**
 * AutoOnLux
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOnLux(adapter, Group) {
	const LightGroups = adapter.LightGroups;
	try {
		adapter.log.debug(
			`Reaching AutoOnLux for Group="${Group} enabled="${LightGroups[Group].autoOnLux?.enabled}", actuallux="${LightGroups[Group].actualLux}", minLux="${LightGroups[Group].autoOnLux?.minLux}" LightGroups[Group].autoOnLux.dailyLock="${LightGroups[Group].autoOnLux?.dailyLock}"`,
		);

		let tempBri = 0;
		let tempColor = "";

		let minLux = 500;

		if (LightGroups[Group].autoOnLux?.minLux === undefined) {
			minLux = 500;
			adapter.writeLog(`[ AutoOnLux ] No minLux defined for Group="${Group}". Use default minLux of 500lux`);
		}

		if (LightGroups[Group].autoOnLux?.operator == "<") {
			if (
				LightGroups[Group].autoOnLux?.enabled &&
				!LightGroups[Group].power &&
				!LightGroups[Group].autoOnLux?.dailyLock &&
				LightGroups[Group].actualLux <= minLux
			) {
				adapter.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if (
					(LightGroups[Group].autoOnLux?.switchOnlyWhenPresence && adapter.ActualPresence) ||
					(LightGroups[Group].autoOnLux?.switchOnlyWhenNoPresence && !adapter.ActualPresence)
				) {
					await GroupPowerOnOff(adapter, Group, true);
					tempBri =
						LightGroups[Group].autoOnLux?.bri !== 0
							? LightGroups[Group].autoOnLux?.bri
							: (tempBri = LightGroups[Group].bri);
					await SetWhiteSubstituteColor(adapter, Group);
					tempColor =
						LightGroups[Group].autoOnLux?.color !== ""
							? LightGroups[Group].autoOnLux?.color
							: (tempColor = LightGroups[Group].color);
					await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);
				}

				LightGroups[Group].autoOnLux.dailyLock = true;

				await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);
			} else if (LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux > minLux) {
				//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					adapter.log.info(`AutoOn_Lux() setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`);
				}
			}
		} else if (LightGroups[Group].autoOnLux.operator == ">") {
			if (
				LightGroups[Group].autoOnLux.enabled &&
				!LightGroups[Group].power &&
				!LightGroups[Group].autoOnLux.dailyLock &&
				LightGroups[Group].actualLux >= minLux
			) {
				adapter.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if (
					(LightGroups[Group].autoOnLux.switchOnlyWhenPresence && adapter.ActualPresence) ||
					(LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !adapter.ActualPresence)
				) {
					await GroupPowerOnOff(adapter, Group, true);
					tempBri =
						LightGroups[Group].autoOnLux.bri !== 0
							? LightGroups[Group].autoOnLux.bri
							: (tempBri = LightGroups[Group].bri);
					await SetWhiteSubstituteColor(adapter, Group);
					tempColor =
						LightGroups[Group].autoOnLux.color !== ""
							? LightGroups[Group].autoOnLux.color
							: LightGroups[Group].color;
					await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);
				}

				LightGroups[Group].autoOnLux.dailyLock = true;
				await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);
			} else if (LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux < minLux) {
				//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					adapter.log.info(`AutoOn_Lux => setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`);
				}
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "AutoOnLux", JSON.stringify(LightGroups[Group].autoOnLux));
	}
}

/**
 * AutoOnMotion
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOnMotion(adapter, Group) {
	const LightGroups = adapter.LightGroups;
	try {
		let tempBri = 0;
		let tempColor = "";

		adapter.writeLog(
			`Reaching AutoOnMotion for Group:"${Group}, enabled="${LightGroups[Group].autoOnMotion?.enabled}", actuallux="${LightGroups[Group].actualLux}", minLux="${LightGroups[Group].autoOnMotion.minLux}"`,
		);

		if (
			LightGroups[Group].autoOnMotion?.enabled &&
			LightGroups[Group].actualLux < LightGroups[Group].autoOnMotion?.minLux &&
			LightGroups[Group].isMotion
		) {
			adapter.writeLog(`Motion for Group="${Group} detected, switching on`, "info");
			await GroupPowerOnOff(adapter, Group, true);

			tempBri =
				LightGroups[Group].autoOnMotion?.bri !== 0
					? LightGroups[Group].autoOnMotion?.bri
					: (tempBri = LightGroups[Group].bri);
			await SetWhiteSubstituteColor(adapter, Group);
			tempColor =
				LightGroups[Group].autoOnMotion?.color !== ""
					? LightGroups[Group].autoOnMotion?.color
					: (tempColor = LightGroups[Group].color);
			await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);
		}
	} catch (error) {
		adapter.errorHandling(error, "AutoOnMotion", JSON.stringify(LightGroups[Group].autoOnMotion));
	}
}

/**
 * AutoOnPresenceIncrease
 * @param {object} adapter Adapter-Class
 */
async function AutoOnPresenceIncrease(adapter) {
	try {
		adapter.log.debug(`Reaching AutoOnPresenceIncrease`);
		const LightGroups = adapter.LightGroups;
		let tempBri = 0;
		let tempColor = "";

		for (const Group in LightGroups) {
			if (Group === "All") continue;

			if (
				LightGroups[Group].autoOnPresenceIncrease.enabled &&
				LightGroups[Group].actualLux < LightGroups[Group].autoOnPresenceIncrease.minLux &&
				!LightGroups[Group].power
			) {
				await GroupPowerOnOff(adapter, Group, true);
				tempBri =
					LightGroups[Group].autoOnPresenceIncrease.bri !== 0
						? LightGroups[Group].autoOnPresenceIncrease.bri
						: LightGroups[Group].bri;
				await SetWhiteSubstituteColor(adapter, Group);
				tempColor =
					LightGroups[Group].autoOnPresenceIncrease.color !== ""
						? LightGroups[Group].autoOnPresenceIncrease.color
						: (tempColor = LightGroups[Group].color);
				await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);
			}
		}
	} catch (e) {
		adapter.writeLog(`AutoOnPresenceIncrease => ${e}`, "error");
	}
}

/**
 * Blink
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function blink(adapter, Group) {
	try {
		adapter.setStateAsync(Group + ".blink.enabled", true, true);
		const LightGroups = adapter.LightGroups;
		let loopcount = 0;

		//Save actual power state
		await SetValueToObject(LightGroups[Group], "blink.actual_power", LightGroups[Group].power);

		if (!LightGroups[Group].power) {
			//Wenn Gruppe aus, anschalten und ggfs. Helligkeit und Farbe setzen

			adapter.writeLog(`[ Blink ] on ${loopcount}`, "info");

			for (const Light of LightGroups[Group].lights) {
				if (!Light?.power?.oid && !Light?.bri?.oid) {
					adapter.writeLog(
						`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
						"warn",
					);
				} else if (Light?.bri?.useBri && Light?.bri?.oid) {
					await adapter.setForeignStateAsync(Light.bri.oid, LightGroups[Group].blink.bri, false);
					adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
				} else if (Light?.power?.oid) {
					await adapter.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
					adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
					if (Light?.bri?.oid && LightGroups[Group].blink.bri !== 0)
						await setDeviceBri(adapter, Light, LightGroups[Group].blink.bri);
				}
			}

			LightGroups[Group].power = true;
			await adapter.setStateAsync(Group + ".power", true, true);

			await SetWhiteSubstituteColor(adapter, Group);

			if (LightGroups[Group].blink.color != "") await SetColor(adapter, Group, LightGroups[Group].blink.color);

			loopcount++;
		}

		await clearBlinkIntervals(adapter, Group);

		adapter.BlinkIntervalObj[Group] = setInterval(async function () {
			// Wenn

			loopcount++;

			adapter.writeLog(`[ Blink ] Is Infinite: ${LightGroups[Group].blink.infinite}`);
			adapter.writeLog(`[ Blink ] Stop: ${LightGroups[Group].blink.stop || false}`);

			if (
				(loopcount <= LightGroups[Group].blink.blinks * 2 || LightGroups[Group].blink.infinite) &&
				!LightGroups[Group].blink.stop
			) {
				if (LightGroups[Group].power) {
					adapter.writeLog(`[ Blink ] off ${loopcount}`, "info");

					for (const Light of LightGroups[Group].lights) {
						if (!Light?.power?.oid && !Light?.bri?.oid) {
							adapter.writeLog(
								`[ Blink ] Can't switch off. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
								"warn",
							);
						} else if (Light?.bri?.useBri && Light?.bri?.oid) {
							await adapter.setForeignStateAsync(Light.bri.oid, 0, false);
							adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: off`);
						} else if (Light?.power?.oid) {
							await adapter.setForeignStateAsync(Light.power.oid, Light.power.offVal, false);
							adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
						}
					}

					await SetWhiteSubstituteColor(adapter, Group);

					if (LightGroups[Group].blink.color != "")
						await SetColor(adapter, Group, LightGroups[Group].blink.color);

					LightGroups[Group].power = false;
					adapter.setStateAsync(Group + ".power", false, true);
					//adapter.SetLightState();
				} else {
					adapter.writeLog(`Blink => on ${loopcount}`, "info");

					for (const Light of LightGroups[Group].lights) {
						if (!Light?.power?.oid && !Light?.bri?.oid) {
							adapter.writeLog(
								`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
								"warn",
							);
						} else if (Light?.bri?.useBri && Light?.bri?.oid) {
							await adapter.setForeignStateAsync(Light.bri.oid, LightGroups[Group].blink.bri, false);
							adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
						} else if (Light?.power?.oid) {
							await adapter.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
							adapter.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
						}
					}

					LightGroups[Group].power = true;
					adapter.setStateAsync(Group + ".power", true, true);
					//adapter.SetLightState();
				}
			} else {
				await clearBlinkIntervals(adapter, Group);
				adapter.setStateAsync(Group + ".blink.enabled", false, true);
				if (LightGroups[Group].blink.infinite || LightGroups[Group].blink.actual_power) {
					await adapter.setStateAsync(Group + ".power", LightGroups[Group].blink.actual_power, false);
					await SetColor(adapter, Group, LightGroups[Group].color);
				}
			}
		}, LightGroups[Group].blink.frequency * 1000);
	} catch (error) {
		adapter.errorHandling(error, "blink");
	}
}

/**
 * AutoOffLux
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOffLux(adapter, Group) {
	//Handling für AutoOffLux
	try {
		const LightGroups = adapter.LightGroups;
		adapter.writeLog(`[ AutoOffLux ] Reaching for Group="${Group}"`);

		if (
			LightGroups[Group].autoOffLux.operator == "<" &&
			LightGroups[Group].actualLux < LightGroups[Group].autoOffLux.minLux &&
			LightGroups[Group].autoOffLux.enabled &&
			LightGroups[Group].power &&
			!LightGroups[Group].autoOffLux.dailyLock
		) {
			await GroupPowerOnOff(adapter, Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
		} else if (
			LightGroups[Group].autoOffLux.operator == ">" &&
			LightGroups[Group].actualLux > LightGroups[Group].autoOffLux.minLux &&
			LightGroups[Group].autoOffLux.enabled &&
			LightGroups[Group].power &&
			!LightGroups[Group].autoOffLux.dailyLock
		) {
			await GroupPowerOnOff(adapter, Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
		}

		if (LightGroups[Group].autoOffLux.operator == "<") {
			//DailyLock resetten

			if (
				LightGroups[Group].actualLux > LightGroups[Group].autoOffLux.minLux &&
				LightGroups[Group].autoOffLux.dailyLock
			) {
				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {
					LightGroups[Group].autoOffLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		} else if (LightGroups[Group].autoOffLux.operator == ">") {
			if (
				LightGroups[Group].actualLux < LightGroups[Group].autoOffLux.minLux &&
				LightGroups[Group].autoOffLux.dailyLock
			) {
				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {
					LightGroups[Group].autoOffLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "AutoOffLux", "Group: " + Group);
	}
}

/**
 * AutoOffTimed
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOffTimed(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;

		adapter.writeLog(
			`[ AutoOffTimed ] Reaching for Group="${Group}" set time="${LightGroups[Group].autoOffTimed.autoOffTime}" LightGroups[${Group}].isMotion="${LightGroups[Group].isMotion}" LightGroups[${Group}].autoOffTimed.noAutoOffWhenMotion="${LightGroups[Group].autoOffTimed.noAutoOffWhenMotion}"`,
		);

		await clearAutoOffTimeouts(adapter, Group);

		if (LightGroups[Group].autoOffTimed.enabled) {
			adapter.writeLog(`[ AutoOffTimed ] Start Timeout`);

			adapter.AutoOffTimeoutObject[Group] = setTimeout(async function () {
				// Interval starten
				if (LightGroups[Group].autoOffTimed.noAutoOffWhenMotion && LightGroups[Group].isMotion) {
					//Wenn noAutoOffWhenmotion aktiv und Bewegung erkannt
					adapter.writeLog(
						`[ AutoOffTimed ] Motion already detected, restarting Timeout for Group="${Group}" set time="${LightGroups[Group].autoOffTimed.autoOffTime}"`,
					);
					adapter.writeLog(`[ AutoOffTimed ] Timer: ${JSON.stringify(adapter.AutoOffTimeoutObject[Group])}`);
					await AutoOffTimed(adapter, Group);
				} else {
					adapter.writeLog(
						`[ AutoOffTimed ] Group="${Group}" timed out, switching off. Motion="${LightGroups[Group].isMotion}"`,
					);
					await GroupPowerOnOff(adapter, Group, false);
				}
			}, Math.round(LightGroups[Group].autoOffTimed.autoOffTime) * 1000);
		}
	} catch (error) {
		adapter.errorHandling(error, "AutoOffTimed", "Group: " + Group);
	}
}

/**
 * SetMasterPower
 * @param {object} adapter Adapter-Class
 * @param NewVal New Value of state
 */
async function SetMasterPower(adapter, NewVal) {
	const funcName = "SetMasterPower";
	try {
		const LightGroups = adapter.LightGroups;

		adapter.writeLog(`[ ${funcName} ] Reaching SetMasterPower`);

		const promises = Object.keys(LightGroups)
			.filter((Group) => Group !== "All")
			.map((Group) => {
				adapter.writeLog(`[ ${funcName} ] Switching Group="${Group}" to ${NewVal}`);
				return adapter.setStateAsync(Group + ".power", NewVal, false);
			});

		await Promise.all(promises);
	} catch (error) {
		adapter.errorHandling(error, "SetMasterPower");
	}
}

module.exports = {
	SimpleGroupPowerOnOff,
	GroupPowerCleaningLightOnOff,
	GroupPowerOnOff,
	AutoOnLux,
	AutoOnMotion,
	AutoOnPresenceIncrease,
	blink,
	AutoOffLux,
	AutoOffTimed,
	SetMasterPower,
};
