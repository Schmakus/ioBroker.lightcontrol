"use strict";

const { clearAutoOffTimeouts, clearRampOnIntervals, clearRampOffIntervals, clearBlinkIntervals } = require("./timers");
const { setDeviceBri, SetWhiteSubstituteColor, PowerOnAftercare,  SetBrightness, SetColor } = require("./lightHandling");

/**
 * SimpleGroupPowerOnOff
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function SimpleGroupPowerOnOff(adapter, Group, OnOff) {
	try {
		const LightGroups = adapter.LightGroups;
		if (OnOff) { //Anschalten

			adapter.log.debug(`SimpleGroupPowerOnOff => Normales anschalten ohne Ramping für Group="${Group}"`);

			for (const Light in LightGroups[Group].lights) {
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal);
				adapter.log.debug(`SimpleGroupPowerOnOff => Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: ${OnOff}`);
			}

		} else { //Ausschalten

			adapter.log.debug("SimpleGroupPowerOnOff => Normales ausschalten ohne Ramping für " + LightGroups[Group].description);

			for (const Light in LightGroups[Group].lights) {
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal);
				adapter.log.debug(`SimpleGroupPowerOnOff => Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: ${OnOff}`);
			}

		}

		await adapter.setState(Group + ".power", OnOff, true);
		LightGroups[Group].power = OnOff;
		await adapter.SetLightState();

		return true;

	} catch(e) {
		adapter.log.error(`SimpleGroupPowerOnOff => ${e}`);
	}
}

/**
 * SimpleGroupPowerOnOff
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function GroupPowerOnOff(adapter, Group, OnOff) {
	try {
		const LightGroups = adapter.LightGroups;
		const RampSteps = adapter.GlobalSettings.RampSteps;

		adapter.log.debug(`Reaching GroupPowerOnOff for Group="${Group}", OnOff="${OnOff}" rampOn="${LightGroups[Group].rampOn.enabled}" - ${JSON.stringify(LightGroups[Group].rampOn)} rampOff="${LightGroups[Group].rampOff.enabled}" - ${JSON.stringify(LightGroups[Group].rampOff)}`);

		let LoopCount = 0;

		//Normales schalten ohne Ramping
		if (OnOff && !LightGroups[Group].rampOn.enabled) { //Anschalten

			await SimpleGroupPowerOnOff(adapter, Group, OnOff);

			if (LightGroups[Group].autoOffTimed.enabled) { //Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

				AutoOffTimed(adapter, Group);

			}


		} else if (!OnOff && !LightGroups[Group].rampOff.enabled) { //Ausschalten

			if (LightGroups[Group].rampOn.enabled) {//Vor dem ausschalten Helligkeit auf 2 (0+1 wird bei manchchen Devices als aus gewertet) um bei rampon nicht mit voller Pulle zu starten

				await setDeviceBri(adapter, Group, 2);

			}

			await SimpleGroupPowerOnOff(adapter, Group, OnOff);

		}

		// Anschalten mit ramping
		if (OnOff && LightGroups[Group].rampOn.enabled && LightGroups[Group].rampOn.switchOutletsLast) { //Anschalten mit Ramping und einfache Lampen/Steckdosen zuletzt

			adapter.log.debug(`Anschalten mit Ramping und einfache Lampen zuletzt für Group="${Group}"`);

			for (const Light in LightGroups[Group].lights) { //Alles anschalten wo
				if (LightGroups[Group].lights[Light].bri.oid !== "") {

					await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal);

				}
			}

			await clearRampOnIntervals(adapter, Group);

			adapter.RampOnIntervalObject[Group] = setInterval(async function () {

				LoopCount++;

				await setDeviceBri(adapter, Group, Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)));

				if (LoopCount >= RampSteps) { //Interval stoppen und einfache Lampen schalten

					for (const Light in LightGroups[Group].lights) { //Alles anschalten wo

						if (LightGroups[Group].lights[Light].bri.oid === "") {

							await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal);

						}
					}
					if (LightGroups[Group].autoOffTimed.enabled) { //Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

						AutoOffTimed(adapter, Group);

					}

					await clearRampOnIntervals(adapter, Group);

				}
			}, Math.round(LightGroups[Group].rampOn.time / RampSteps) * 1000);

		} else if (OnOff && LightGroups[Group].rampOn.enabled && !LightGroups[Group].rampOn.switchOutletsLast) { //Anschalten mit Ramping und einfache Lampen zuerst

			adapter.log.debug(`GroupPowerOnOff: Anschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			for (const Light in LightGroups[Group].lights) { //Alles anschalten
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal);
			}

			await clearRampOnIntervals(adapter, Group);

			adapter.RampOnIntervalObject[Group] = setInterval(async function () { // Interval starten

				await setDeviceBri(adapter, Group, Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)));

				LoopCount++;

				if (LoopCount >= RampSteps) {

					if (LightGroups[Group].autoOffTimed.enabled) { //Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

						AutoOffTimed(adapter, Group);

					}

					await clearRampOnIntervals(adapter, Group);

				}

			}, Math.round(LightGroups[Group].rampOn.time / RampSteps) * 1000);

		}

		//Ausschalten mit Ramping
		else if (!OnOff && LightGroups[Group].rampOff.enabled && LightGroups[Group].rampOff.switchOutletsLast) { ////Ausschalten mit Ramping und einfache Lampen zuletzt

			adapter.log.debug(`GroupPowerOnOff: Ausschalten mit Ramping und einfache Lampen zuletzt für Group="${Group}"`);

			await clearRampOffIntervals(adapter, Group);

			adapter.RampOffIntervalObject[Group] = setInterval(async function () { // Interval starten

				await setDeviceBri(adapter, Group, LightGroups[Group].bri - LightGroups[Group].bri / RampSteps - Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)));

				LoopCount++;

				if (LoopCount >= RampSteps) {

					await clearRampOffIntervals(adapter, Group);

					for (const Light in LightGroups[Group].lights) {
						if (LightGroups[Group].lights[Light].bri.oid === "") { //prüfen ob Helligkeitsdatenpunkt vorhanden

							await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal); //Einfache Lampen ausschalten, dann

						}
					}
				}
			}, Math.round(LightGroups[Group].rampOff.time / RampSteps) * 1000);

		} else if (!OnOff && LightGroups[Group].rampOff.enabled && !LightGroups[Group].rampOff.switchOutletsLast) { ////Ausschalten mit Ramping und einfache Lampen zuerst

			adapter.log.debug(`GroupPowerOnOff => Ausschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			for (const Light in LightGroups[Group].lights) {
				if (LightGroups[Group].lights[Light].bri.oid === "") { //prüfen ob Helligkeitsdatenpunkt vorhanden, wenn nein
					await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal); //Einfache Lampen ausschalten, dann
					// log("GroupPowerOnOff: F Switching " + Light + " " + LightGroups[Group].lights[Light].power.oid + " to: " + OnOff);
				}
			}

			await clearRampOffIntervals(adapter, Group);

			adapter.RampOffIntervalObject[Group] = setInterval(async function () {

				LightGroups[Group].power = true;

				await setDeviceBri(adapter, Group, LightGroups[Group].bri - LightGroups[Group].bri / RampSteps - Math.round(RampSteps * LoopCount * (LightGroups[Group].bri / 100)));

				LoopCount++;

				if (LoopCount >= RampSteps) {

					LightGroups[Group].power = false;
					await DeviceSwitch(adapter, Group, OnOff);
					await clearRampOffIntervals(adapter, Group);

				}

			}, Math.round(LightGroups[Group].rampOff.time / RampSteps) * 1000);
		}

		await adapter.setStateAsync(Group + ".power", OnOff, true).catch((e) => adapter.log.error(`GroupPowerOnOff => ${e}`)); // Power on mit ack bestätigen, bzw. bei Auto Funktionen nach Ausführung den DP setzen
		LightGroups[Group].power = OnOff;
		await adapter.SetLightState().catch((e) => adapter.log.error(`GroupPowerOnOff => ${e}`));
		return true;

	} catch(e) {
		adapter.log.error(`GroupPowerOnOff => ${e}`);
	}
}

/**
 * DeviceSwitch
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function DeviceSwitch(adapter, Group, OnOff) { //Ausgelagert von GroupOnOff da im Interval kein await möglich
	try {

		adapter.log.debug(`Reaching DeviceSwitch for Group="${Group}, OnOff="${OnOff}"`);

		const LightGroups = adapter.LightGroups;

		for (const Light in LightGroups[Group].lights) {
			if (LightGroups[Group].lights[Light].bri.oid !== "") { //prüfen ob Helligkeitsdatenpunkt vorhanden, wenn ja
				await adapter.setStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal); //Lampen schalten
				adapter.log.debug(`DeviceSwitch: Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: ${OnOff}`);
			}
		}

	} catch(e) {
		adapter.log.error(`DeviceSwitch => ${e}`);
	}
}

/**
 * GroupPowerCleaningLightOnOff
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {boolean} OnOff true/false from power state
 */
async function GroupPowerCleaningLightOnOff(adapter, Group, OnOff) {
	try {
		adapter.log.debug(`Reaching GroupPowerCleaningLightOnOff for Group="${Group}, OnOff="${OnOff}"`);
		const LightGroups = adapter.LightGroups;

		if (OnOff) { //Anschalten

			await clearAutoOffTimeouts(adapter, Group);

			for (const Light in LightGroups[Group].lights) {
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal);
				adapter.log.info(`GroupPowerCleaningLightOnOff: Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: ${OnOff}`);
				if (LightGroups[Group].lights[Light].bri.oid !== "") { //Prüfen ob Eintrag für Helligkeit vorhanden
					await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].bri.oid, LightGroups[Group].lights[Light].bri.maxVal, false); //Auf max. Helligkeit setzen
				}
			}

		} else { //Ausschalten

			for (const Light in LightGroups[Group].lights) {
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal);
				adapter.log.info("GroupPowerCleaningLightOnOff: Switching " + Light + " " + LightGroups[Group].lights[Light].power.oid + " to: " + OnOff);
			}
		}

		await adapter.setStateAsync(Group + ".powerCleaningLight", LightGroups[Group].powerCleaningLight, true);
		await adapter.setStateAsync(Group + ".power", OnOff, true);
		LightGroups[Group].power = OnOff;
		await adapter.SetLightState();

	} catch(e) {
		adapter.log.error(`GroupPowerCleaningLightOnOff => ${e}`);
	}
}

/**
 * AutoOnLux
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOnLux(adapter, Group) {
	try {

		const LightGroups = adapter.LightGroups;

		adapter.log.debug(`Reaching AutoOnLux for Group="${Group} enabled="${LightGroups[Group].autoOnLux.enabled}", actuallux="${LightGroups[Group].actualLux}", minLux="${LightGroups[Group].autoOnLux.minLux}" LightGroups[Group].autoOnLux.dailyLock="${LightGroups[Group].autoOnLux.dailyLock}"`);

		let tempBri = 0;
		let tempColor = "";

		if (LightGroups[Group].autoOnLux.operator == "<") {

			if (LightGroups[Group].autoOnLux.enabled && !LightGroups[Group].power && !LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux <= LightGroups[Group].autoOnLux.minLux) {

				adapter.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if ((LightGroups[Group].autoOnLux.switchOnlyWhenPresence && adapter.ActualPresence) || (LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !adapter.ActualPresence)) {

					await GroupPowerOnOff(adapter, Group, true);
					tempBri = (LightGroups[Group].autoOnLux.bri !== 0) ? LightGroups[Group].autoOnLux.bri : tempBri = LightGroups[Group].bri;
					await SetWhiteSubstituteColor(adapter, Group);
					tempColor = (LightGroups[Group].autoOnLux.color !== "") ? LightGroups[Group].autoOnLux.color : tempColor = LightGroups[Group].color;
					await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);

				}

				LightGroups[Group].autoOnLux.dailyLock = true;

				await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);

			} else if (LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux > LightGroups[Group].autoOnLux.minLux) {//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux.dailyLockCounter >= 5) { //5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					adapter.log.info(`AutoOn_Lux() setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`);

				}
			}

		} else if (LightGroups[Group].autoOnLux.operator == ">") {

			if (LightGroups[Group].autoOnLux.enabled && !LightGroups[Group].power && !LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux >= LightGroups[Group].autoOnLux.minLux) {

				adapter.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if ((LightGroups[Group].autoOnLux.switchOnlyWhenPresence && adapter.ActualPresence) || (LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !adapter.ActualPresence)) {

					await GroupPowerOnOff(adapter, Group, true);
					tempBri = (LightGroups[Group].autoOnLux.bri !== 0) ? LightGroups[Group].autoOnLux.bri : tempBri = LightGroups[Group].bri;
					await SetWhiteSubstituteColor(adapter, Group);
					tempColor = (LightGroups[Group].autoOnLux.color !== "") ? LightGroups[Group].autoOnLux.color : LightGroups[Group].color;
					await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);

				}

				LightGroups[Group].autoOnLux.dailyLock = true;
				await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);

			} else if (LightGroups[Group].autoOnLux.dailyLock && LightGroups[Group].actualLux < LightGroups[Group].autoOnLux.minLux) {//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux.dailyLockCounter >= 5) { //5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					adapter.log.info(`AutoOn_Lux => setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`);

				}
			}
		}

	} catch(e) {
		adapter.log.warn(`AutoOnLux => ${e}`);
	}
}

/**
 * AutoOnMotion
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOnMotion(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		let tempBri = 0;
		let tempColor = "";

		adapter.log.debug(`Reaching AutoOnMotion for Group:"${Group}, enabled="${LightGroups[Group].autoOnMotion.enabled}", actuallux="${LightGroups[Group].actualLux}", minLux="${LightGroups[Group].autoOnMotion.minLux}"`);

		if (LightGroups[Group].autoOnMotion.enabled && LightGroups[Group].actualLux < LightGroups[Group].autoOnMotion.minLux && LightGroups[Group].isMotion) {

			adapter.log.info(`Motion for Group="${Group} detected, switching on`);
			await GroupPowerOnOff(adapter, Group, true);

			tempBri = (LightGroups[Group].autoOnMotion.bri !== 0) ? LightGroups[Group].autoOnMotion.bri : tempBri = LightGroups[Group].bri;
			await SetWhiteSubstituteColor(adapter, Group);
			tempColor = (LightGroups[Group].autoOnMotion.color !== "") ? LightGroups[Group].autoOnMotion.color : tempColor = LightGroups[Group].color;
			await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);

		}

	} catch(e) {
		adapter.log.warn(`AutoOnMotion => ${e}`);
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

			if (LightGroups[Group].autoOnPresenceIncrease.enabled && LightGroups[Group].actualLux < LightGroups[Group].autoOnPresenceIncrease.minLux && !LightGroups[Group].power) {

				await GroupPowerOnOff(adapter, Group, true);
				tempBri = (LightGroups[Group].autoOnPresenceIncrease.bri !== 0) ? LightGroups[Group].autoOnPresenceIncrease.bri : LightGroups[Group].bri;
				await SetWhiteSubstituteColor(adapter, Group);
				tempColor = (LightGroups[Group].autoOnPresenceIncrease.color !== "") ? LightGroups[Group].autoOnPresenceIncrease.color : tempColor = LightGroups[Group].color;
				await PowerOnAftercare(adapter, Group, tempBri, LightGroups[Group].ct, tempColor);

			}
		}

	} catch(e) {
		adapter.log.warn(`AutoOnPresenceIncrease => ${e}`);
	}
}

/**
 * AutoOnMotion
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function blink(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		let loopcount = 0;

		if (!LightGroups[Group].power) { //Wenn Gruppe aus, anschalten und ggfs. Helligkeit und Farbe setzen

			adapter.log.info(`on ${loopcount}`);

			for (const Light in LightGroups[Group].lights) {
				await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal, false);
				adapter.log.debug(`Blink: Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: on`);
			}

			LightGroups[Group].power = true;
			await adapter.setStateAsync(Group + ".power", true, true);
			await adapter.SetLightState();

			if (LightGroups[Group].blink.bri != 0) await SetBrightness(adapter, Group, LightGroups[Group].blink.bri);

			await SetWhiteSubstituteColor(adapter, Group);

			if (LightGroups[Group].blink.color != "") await SetColor(adapter, Group, LightGroups[Group].blink.color);

			loopcount++;
		}

		await clearBlinkIntervals(adapter, Group);

		adapter.BlinkIntervalObj[Group] = setInterval(async function () { // Wenn

			loopcount++;

			if (loopcount <= LightGroups[Group].blink.blinks * 2) {

				if (LightGroups[Group].power) {

					adapter.log.info(`off ${loopcount}`);

					for (const Light in LightGroups[Group].lights) {

						await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.offVal, false);
						adapter.log.info(`Blink: Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: off`);

					}

					LightGroups[Group].power = false;
					adapter.setStateAsync(Group + ".power", false, true);
					adapter.SetLightState();

				} else {

					adapter.log.info("on " + loopcount);

					for (const Light in LightGroups[Group].lights) {
						adapter.setForeignStateAsync(LightGroups[Group].lights[Light].power.oid, LightGroups[Group].lights[Light].power.onVal, false);
						adapter.log.info(`Blink: Switching ${Light} ${LightGroups[Group].lights[Light].power.oid} to: on`);
					}

					LightGroups[Group].power = true;
					adapter.setStateAsync(Group + ".power", true, true);
					adapter.SetLightState();

				}

			} else {

				await clearBlinkIntervals(adapter, Group);

			}

		}, LightGroups[Group].blink.frequency * 1000);

	} catch(e) {
		adapter.log.warn(`blink => ${e}`);
	}
}

/**
 * AutoOffLux
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AutoOffLux(adapter, Group) {//Handling für AutoOffLux
	try {
		const LightGroups = adapter.LightGroups;
		adapter.log.debug(`Reaching AutoOffLux, for Group="${Group}"`);

		if (LightGroups[Group].autoOffLux.operator == "<" && LightGroups[Group].actualLux < LightGroups[Group].autoOffLux.minLux && LightGroups[Group].autoOffLux.enabled && LightGroups[Group].power && !LightGroups[Group].autoOffLux.dailyLock) {

			await GroupPowerOnOff(adapter, Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);

		} else if (LightGroups[Group].autoOffLux.operator == ">" && LightGroups[Group].actualLux > LightGroups[Group].autoOffLux.minLux && LightGroups[Group].autoOffLux.enabled && LightGroups[Group].power && !LightGroups[Group].autoOffLux.dailyLock) {

			await GroupPowerOnOff(adapter, Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);

		}

		if (LightGroups[Group].autoOffLux.operator == "<") { //DailyLock resetten

			if (LightGroups[Group].actualLux > LightGroups[Group].autoOffLux.minLux && LightGroups[Group].autoOffLux.dailyLock) {

				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {

					LightGroups[Group].autoOffLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;

				}
			}

		} else if (LightGroups[Group].autoOffLux.operator == ">") {

			if (LightGroups[Group].actualLux < LightGroups[Group].autoOffLux.minLux && LightGroups[Group].autoOffLux.dailyLock) {

				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {

					LightGroups[Group].autoOffLux.dailyLock = false;
					await adapter.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;

				}
			}
		}

	} catch(e) {
		adapter.log.error(`AutoOffLux => ${e}`);
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

		adapter.log.debug(`Reaching AutoOffTimed for Group="${Group}" set time="${LightGroups[Group].autoOffTimed.autoOffTime}" LightGroups[${Group}].isMotion="${LightGroups[Group].isMotion}" LightGroups[${Group}].autoOffTimed.noAutoOffWhenMotion="${LightGroups[Group].autoOffTimed.noAutoOffWhenMotion}"`);

		await clearAutoOffTimeouts(adapter, Group);

		if (LightGroups[Group].autoOffTimed.enabled) {

			adapter.log.debug(`AutoOffTimed => Start Timeout`);

			adapter.AutoOffTimeoutObject[Group] = setTimeout(async function () { // Interval starten
				if (LightGroups[Group].autoOffTimed.noAutoOffWhenMotion && LightGroups[Group].isMotion) { //Wenn noAutoOffWhenmotion aktiv und Bewegung erkannt
					adapter.log.debug(`AutoOffTimed => Motion already detected, restarting Timeout for Group="${Group}" set time="${LightGroups[Group].autoOffTimed.autoOffTime}"`);
					adapter.log.debug(`AutoOffTimed => Timer: ${JSON.stringify(adapter.AutoOffTimeoutObject[Group])}`);
					await AutoOffTimed(adapter, Group);
				} else {
					adapter.log.debug(`AutoOffTimed => Group="${Group}" timed out, switching off. Motion="${LightGroups[Group].isMotion}"`);
					await GroupPowerOnOff(adapter,Group, false);
				}
			}, Math.round(LightGroups[Group].autoOffTimed.autoOffTime) * 1000);
		}

	} catch(e) {
		adapter.log.error(`AutoOffTimed => ${e}`);
	}
}

/**
 * SetMasterPower
 * @param {object} adapter Adapter-Class
 * @param NewVal New Value of state
 */
async function SetMasterPower(adapter, NewVal) {
	try {
		const LightGroups = adapter.LightGroups;

		adapter.log.debug(`Reaching SetMasterPower`);
		adapter.log.debug(`SetMasterPower: ${LightGroups}`);

		for (const Group in LightGroups) {
			if (Group === "All") continue;
			adapter.log.debug(`Switching Group="${Group}", Id: ${Group}.power to NewVal`);
			await adapter.setStateAsync(Group + ".power", NewVal, false);
		}

	} catch(e) {
		adapter.log.error(`SetMasterPower => ${e}`);
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
	SetMasterPower
};