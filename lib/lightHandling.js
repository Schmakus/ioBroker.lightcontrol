/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable indent */
"use strict";
const SunCalc = require("suncalc2");
const getAstroDate = require("./helper").getAstroDate;
const compareTime = require("./helper").compareTime;
const { getDateObject } = require("./helper");
const colorConv = require("./colorCoversation");

/**
 * AdaptiveBri
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AdaptiveBri(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		adapter.writeLog(
			`[ AdaptiveBri ] Reaching for Group="${Group}" actual Lux="${LightGroups[Group].actualLux}" generic lux="${adapter.ActualGenericLux}`,
		);

		let TempBri = 0;

		if (LightGroups[Group].adaptiveBri) {
			if (LightGroups[Group].actualLux === 0) {
				TempBri = parseInt(adapter.Settings.minBri);
			} else if (LightGroups[Group].actualLux >= 10000) {
				TempBri = 100;
			} else if (LightGroups[Group].actualLux > 0 && LightGroups[Group].actualLux < 10000) {
				TempBri = LightGroups[Group].actualLux / 100;

				if (TempBri < adapter.Settings.minBri) TempBri = parseInt(adapter.Settings.minBri);
			}
		}
		return Math.round(TempBri);
	} catch (error) {
		adapter.errorHandling(error, "AdaptiveBri");
	}
}

/**
 * SetBrightness
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number | undefined} Brightness Value 0 to 100
 * @param {string} [caller="default"] - Quelle des Funktionsaufrufs. Standardmäßig "default"
 */
async function SetBrightness(adapter, Group, Brightness, caller = "default") {
	const LightGroups = adapter.LightGroups;

	adapter.writeLog(
		`[ SetBrightness ] Reaching for Group="${Group}", Brightness="${Brightness}, PowerState="${LightGroups[Group].power}"`,
	);

	try {
		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`[ SetBrightness ] Not able to set Brighness for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		//Set Brightness only if Group Power on
		if (LightGroups[Group].power) {
			for (const Light of LightGroups[Group].lights) {
				if (Light?.bri?.oid) {
					await setDeviceBri(adapter, Light, Brightness);
				}
			}
		}

		if (caller === "default") await adapter.setStateAsync(Group + "." + "bri", Brightness, true);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetBrightness");
	}
}

/**
 * Sets the brightness of a device based on the given `Brightness` parameter and the `minVal` and `maxVal` values from the `Light` object.
 * @param {object} adapter - The adapter object used for logging and error handling.
 * @param {object} Light - The Light object containing the device information, including the `minVal` and `maxVal` values for the brightness.
 * @param {number | undefined} brightness - The brightness value to be set on the device.
 * @returns {Promise<boolean>} - Returns a Promise that resolves to `true` if the brightness was successfully set, or `false` if there was an error.
 */
async function setDeviceBri(adapter, Light, brightness) {
	try {
		const log = !Light?.bri?.useBri
			? `[ setDeviceBri ] Switching with Power State is activated. Min. Brightness is defined with 2%. Actual Brightness = "${brightness}"`
			: `[ setDeviceBri ] Switching with Brightness is activated. No min. Brightness needed. Actual Brightness = "${brightness}"`;
		adapter.writeLog(log);

		const minBrightness = Light?.bri?.useBri ? 0 : 2;
		brightness = Math.round(Math.min(Math.max(brightness || 0, minBrightness), 100));

		const minVal = Light?.bri?.minVal || 0;
		const maxVal = Light?.bri?.maxVal || 100;
		const defaultBri = Light?.bri?.defaultBri || 100;

		const value = Math.round((brightness / 100) * (maxVal - minVal) + minVal);
		const bri = Math.round((value / maxVal) * defaultBri);

		await adapter.setForeignStateAsync(Light.bri.oid, bri, false);

		return true;
	} catch (error) {
		adapter.errorHandling(error, "setDeviceBri");
		return false;
	}
}

/**
 * setCt
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number} ct
 */
async function SetCt(adapter, Group, ct = adapter.LightGroups[Group].ct) {
	try {
		const LightGroups = adapter.LightGroups;

		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`[ SetCt ] Not able to set Color-Temperature for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		adapter.writeLog(`Reaching SetCt, Group="${Group}" Ct="${LightGroups[Group].ct}"`);

		for (const Light of LightGroups[Group].lights) {
			if ((LightGroups[Group].power || Light?.ct?.sendCt) && Light?.ct?.oid) {
				/*
				const TempCt =
					Light.ct.minVal < 1000 ? await ConvertKelvin(adapter, Light.ct.minVal, Light.ct.maxVal, ct) : ct;
				*/
				const outMinCt = Light?.ct?.minVal || 0;
				const outMaxCt = Light?.ct?.maxVal || 100;
				const CtReverse = Light?.ct?.CtReverse || false;

				await adapter.setForeignStateAsync(
					Light.ct.oid,
					await KelvinToRange(adapter, outMinCt, outMaxCt, ct, CtReverse),
					false,
				);
			}
		}

		await adapter.setStateAsync(Group + ".ct", LightGroups[Group].ct, true);

		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetCt");
	}
}

/**
 * KelvinToRange
 * @param {object} adapter	Adapter-Class
 * @param {number} outMinCt	minimum Ct-Value of target state
 * @param {number} outMaxCt	maximum Ct-Value of target state
 * @param {number} kelvin	kelvin value of group (e.g. 2700)
 * @param {boolean} CtReverse	switch if lower ct-value is cold
 * @returns {Promise<number>} return the Ct-Value of the target state
 */
async function KelvinToRange(adapter, outMinCt, outMaxCt, kelvin, CtReverse = false) {
	try {
		const minCt = adapter.Settings.minCt || 2700;
		const maxCt = adapter.Settings.maxCt || 6500;
		let rangeValue;

		kelvin = Math.min(Math.max(kelvin, minCt), maxCt); // constrain kelvin to minCt and maxCt

		if (CtReverse) {
			rangeValue = ((maxCt - kelvin) / (maxCt - minCt)) * (outMaxCt - outMinCt) + outMinCt;
		} else {
			rangeValue = ((kelvin - minCt) / (maxCt - minCt)) * (outMaxCt - outMinCt) + outMinCt;
		}
		return Math.round(Math.min(Math.max(rangeValue, outMinCt), outMaxCt)); // constrain the range to outMinCt and outMaxCt
	} catch (error) {
		adapter.errorHandling(
			error,
			"KelvinToRange",
			`kelvin: ${kelvin}, outMaxCt: ${outMaxCt}, outMinCt: ${outMinCt}`,
		);
		return -1;
	}
}

/**
 * AdapticeCt
 * @param {object} adapter Adapter-Class
 */
async function AdaptiveCt(adapter) {
	try {
		const LightGroups = adapter.LightGroups;

		const now = new Date();
		const ActualTime = now.getTime();

		const minCt = adapter.Settings.minCt;
		const maxCt = adapter.Settings.maxCt;
		const CtRange = maxCt - minCt;

		adapter.writeLog(`[ AdaptiveCt ] minCT="${minCt}", maxCt="${maxCt}", CtRange="${CtRange}"`);

		let adaptiveCtLinear = 0;
		let adaptiveCtSolar = 0;
		let adaptiveCtSolarInterpolated = 0;
		let adaptiveCtTimed = 0;
		let adaptiveCtTimedInterpolated = 0;
		let sunset = 0;
		let sunrise = 0;
		let solarNoon = 0;

		/*
		const sunsetDate = await getAstroDate(adapter, "sunset", undefined); //Sonnenuntergang
		const sunriseDate = await getAstroDate(adapter, "sunrise", undefined); //Sonnenaufgang
		const solarNoonDate = await getAstroDate(adapter, "solarNoon", undefined); //Höchster Sonnenstand (Mittag)
		*/

		const [sunsetDate, sunriseDate, solarNoonDate] = await Promise.all([
			getAstroDate(adapter, "sunset", undefined),
			getAstroDate(adapter, "sunrise", undefined),
			getAstroDate(adapter, "solarNoon", undefined),
		]);

		adapter.writeLog(
			`[ AdaptiveCt // getAstroDate] sunsetDate="${sunsetDate}", sunriseDate="${sunriseDate}", solarNoonDate="${solarNoonDate}"`,
		);

		if (sunsetDate instanceof Date && sunriseDate instanceof Date && solarNoonDate instanceof Date) {
			sunset = sunsetDate.getTime(); //Sonnenuntergang
			sunrise = sunriseDate.getTime(); //Sonnenaufgang
			solarNoon = solarNoonDate.getTime(); //Höchster Sonnenstand (Mittag)
		} else {
			adapter.writeLog(`[ AdaptiveCt ] sunsetDate, sunriseDate or solarNoonDate are no Date Objects"`, "warn");
			return;
		}

		adapter.writeLog(
			`[ AdaptiveCt ] minCT="${minCt}", maxCt="${maxCt}", sunset="${sunset}", sunrise="${sunrise}", solarNoon="${solarNoon}"`,
		);

		let morningTime = 0;

		const sunMinutesDay = (sunset - sunrise) / 1000 / 60;
		const RangePerMinute = CtRange / sunMinutesDay;

		const sunpos = SunCalc.getPosition(now, adapter.lat, adapter.lng);
		const sunposNoon = SunCalc.getPosition(solarNoon, adapter.lat, adapter.lng);

		if (await compareTime(adapter, sunrise, solarNoon, "between", ActualTime)) {
			//   log("Aufsteigend")
			adaptiveCtLinear = Math.round(minCt + ((ActualTime - sunrise) / 1000 / 60) * RangePerMinute * 2); // Linear = ansteigende Rampe von Sonnenaufgang bis Sonnenmittag, danach abfallend bis Sonnenuntergang
		} else if (await compareTime(adapter, solarNoon, sunset, "between", ActualTime)) {
			//   log("Absteigend")
			adaptiveCtLinear = Math.round(maxCt - ((ActualTime - solarNoon) / 1000 / 60) * RangePerMinute * 2);
		}

		if (await compareTime(adapter, sunrise, sunset, "between", ActualTime)) {
			adaptiveCtSolar = Math.round(minCt + sunMinutesDay * RangePerMinute * sunpos.altitude); // Solar = Sinusrampe entsprechend direkter Elevation, max Ct differiert nach Jahreszeiten
			adaptiveCtSolarInterpolated = Math.round(
				minCt + sunMinutesDay * RangePerMinute * sunpos.altitude * (1 / sunposNoon.altitude),
			); // SolarInterpolated = Wie Solar, jedoch wird der Wert so hochgerechnet dass immer zum Sonnenmittag maxCt gesetzt wird, unabhängig der Jahreszeit
		}

		adapter.writeLog(`[ AdaptiveCt ] adaptiveCtLinear="${adaptiveCtLinear}" adaptiveCtSolar="${adaptiveCtSolar}"`);

		for (const Group in LightGroups) {
			if (Group === "All") continue;

			switch (LightGroups[Group].adaptiveCtMode) {
				case "linear":
					if (LightGroups[Group].adaptiveCt && LightGroups[Group].ct !== adaptiveCtLinear) {
						await adapter.setStateAsync(Group + ".ct", adaptiveCtLinear, false);
					}
					break;

				case "solar":
					if (LightGroups[Group].adaptiveCt && LightGroups[Group].ct !== adaptiveCtSolar) {
						await adapter.setStateAsync(Group + ".ct", adaptiveCtSolar, false);
					}
					break;

				case "solarInterpolated":
					if (LightGroups[Group].adaptiveCt && LightGroups[Group].ct !== adaptiveCtSolarInterpolated) {
						await adapter.setStateAsync(Group + ".ct", adaptiveCtSolarInterpolated, false);
					}
					break;
				case "timed":
					if (LightGroups[Group].adaptiveCt && LightGroups[Group].ct !== adaptiveCtTimed) {
						morningTime = (await getDateObject(LightGroups[Group].adaptiveCtTime)).getTime();
						if (ActualTime >= morningTime && ActualTime <= sunset) {
							adaptiveCtTimed = Math.round(
								maxCt + ((minCt - maxCt) * (ActualTime - morningTime)) / (sunset - morningTime),
							);
						} else {
							adaptiveCtTimed = minCt;
						}

						adapter.writeLog(
							`[ AdaptiveCt // timed ] morningTime="${LightGroups[Group].adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimed}"`,
						);

						await adapter.setStateAsync(Group + ".ct", adaptiveCtTimed, false);
					}
					break;
				case "timedInterpolated":
					if (LightGroups[Group].adaptiveCt && LightGroups[Group].ct !== adaptiveCtTimedInterpolated) {
						morningTime = (await getDateObject(LightGroups[Group].adaptiveCtTime)).getTime();

						if (ActualTime >= morningTime && ActualTime <= sunset) {
							const timeFraction = (ActualTime - morningTime) / (sunset - morningTime);
							const radians = 2 * Math.PI * timeFraction;
							adaptiveCtTimedInterpolated = Math.round(
								maxCt - (maxCt - minCt) * (0.5 * (1 + Math.cos(radians))),
							);
						} else {
							adaptiveCtTimedInterpolated = minCt;
						}

						adapter.writeLog(
							`[ AdaptiveCt // timedInterpolated ] morningTime="${LightGroups[Group].adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimedInterpolated}"`,
						);

						await adapter.setStateAsync(Group + ".ct", adaptiveCtTimedInterpolated, false);
					}
					break;
			}
		}

		//Timeout 60s to restart function
		if (adapter.TickerIntervall) adapter.clearTimeout(adapter.TickerIntervall);

		adapter.TickerIntervall = setTimeout(() => {
			AdaptiveCt(adapter);
		}, 60000);
	} catch (error) {
		adapter.errorHandling(error, "AdaptiveCt");
	}
}

/**
 * SetWhiteSubstituteColor
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function SetWhiteSubstituteColor(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		const minCt = adapter.GlobalSettings.minCt;
		const maxCt = adapter.GlobalSettings.maxCt;

		adapter.writeLog(
			`[ WhiteSubstituteColor ] Reaching for Group="${Group}" = "${LightGroups[Group].description}" LightGroups[Group].power="${LightGroups[Group].power}" LightGroups[Group].color="${LightGroups[Group].color}`,
			"info",
		);

		//Nur ausführen bei anschalten und Farbe weiß

		// log("anschalten und Farbe weiß")
		if (
			LightGroups[Group].ct < (maxCt - minCt) / 4 + minCt ||
			LightGroups[Group].ct > ((maxCt - minCt) / 4) * 3 + minCt
		) {
			//Ct Regelbereich vierteln, erstes viertel ist ww, 2tes und drittes wieder kw, das letzte ww

			for (const Light of LightGroups[Group].lights) {
				if (
					Light.ct &&
					Light.color &&
					LightGroups[Group].color.toUpperCase() == "#FFFFFF" &&
					(LightGroups[Group].power || Light?.color?.sendColor)
				) {
					if (
						!Light?.ct?.oid &&
						Light?.color?.oid &&
						Light?.color?.warmWhiteColor &&
						Light?.color?.dayLightColor
					) {
						await adapter.setForeignStateAsync(Light.color.oid, Light.color.warmWhiteColor, false);
					}
				}
			}
		} else {
			//  log("Kaltweiss")
			for (const Light of LightGroups[Group].lights) {
				if (
					Light.ct &&
					Light.color &&
					LightGroups[Group].color.toUpperCase() == "#FFFFFF" &&
					(LightGroups[Group].power || Light?.color?.sendColor)
				) {
					if (
						!Light?.ct?.oid &&
						Light?.color?.oid &&
						Light?.color?.warmWhiteColor &&
						Light?.color?.dayLightColor
					) {
						await adapter.setForeignStateAsync(Light.color.oid, Light.color.dayLightColor, false);
					}
				}
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "SetWhiteSubstituteColor");
	}
}

/**
 * SetColorMode
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function SetColorMode(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		adapter.writeLog(`[ SetColorMode ] Reaching for Group="${Group}"`, "info");

		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`SetColorMode => Not able to set Color-Mode for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		for (const Light of LightGroups[Group].lights) {
			//Alle Lampen der Gruppe durchgehen
			if (Light.modeswitch && (LightGroups[Group].power || Light?.modeswitch?.sendModeswitch)) {
				if (Light?.modeswitch?.oid) {
					//Prüfen ob Datenpunkt für Colormode vorhanden

					if (LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
						//bei Farbe weiss

						await adapter.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.whiteModeVal, false);
						adapter.writeLog(
							`[ SetColorMode ] Device="${Light.modeswitch.oid}" Val="${Light.modeswitch.whiteModeVal}`,
							"info",
						);
					} else {
						//Bei allen anderen Farben

						await adapter.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.colorModeVal, false);
					}
				}
			}
		}
		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetColorMode");
	}
}

/**
 * SetColor
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {any} Color
 */
async function SetColor(adapter, Group, Color) {
	try {
		const LightGroups = adapter.LightGroups;
		adapter.writeLog(
			`[ SetColor ] Reaching for Group="${Group}" power="${LightGroups[Group].power}" Color="${Color}"`,
			"info",
		);

		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`[ SetColor ] Not able to set Color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const rgbTemp = await colorConv.ConvertHexToRgb(Color);

		for (const Light of LightGroups[Group].lights) {
			if (Light.color && (LightGroups[Group].power || Light?.color?.sendColor)) {
				if (Light?.color?.oid) {
					//Prüfen ob Datenpunkt für Color vorhanden

					switch (Light.color.colorType) {
						case "hex": //Keine Konvertierung nötig
							await adapter.setForeignStateAsync(Light.color.oid, Color, false);
							break;
						case "rgb":
							await adapter.setForeignStateAsync(Light.color.oid, rgbTemp, false);
							break;
						case "xy":
							await adapter.setForeignStateAsync(
								Light.color.oid,
								await colorConv.ConvertRgbToXy(rgbTemp),
								false,
							);
							break;
						default:
							adapter.writeLog(
								`[ SetColor ] Unknown colorType = "${Light.color.colorType}" in Group="${Group}", please specify!`,
								"warn",
							);
					}
				}
			}
		}
		await adapter.setStateAsync(Group + ".color", LightGroups[Group].color, true);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetColor");
	}
}

/**
 * PowerOnAftercare
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number} bri Brighness 0 - 100 %
 * @param {number} ct Color-Temperatur Kelvin
 * @param {string} color Color HEX value
 */
async function PowerOnAftercare(
	adapter,
	Group,
	bri = adapter.LightGroups[Group].bri,
	ct = adapter.LightGroups[Group].ct,
	color = adapter.LightGroups[Group].color,
) {
	try {
		const LightGroups = adapter.LightGroups;
		adapter.writeLog(
			`[ PowerOnAfterCare ] Reaching for Group="${Group}" bri="${bri}" ct="${ct}" color="${color}"`,
			"info",
		);

		if (LightGroups[Group].power) {
			//Nur bei anschalten ausführen

			if (!LightGroups[Group].rampOn.enabled) {
				//Wenn kein RampOn Helligkeit direkt setzen

				if (LightGroups[Group].adaptiveBri) {
					//Bei aktiviertem AdaptiveBri
					await SetBrightness(adapter, Group, await AdaptiveBri(adapter, Group));
				} else {
					adapter.writeLog(`[ PowerOnAfterCare ] Now setting bri to ${bri}% for Group="${Group}"`, "info");
					await SetBrightness(adapter, Group, bri);
				}
			}

			await SetColor(adapter, Group, color); //Nach anschalten Color setzen

			if (color == "#FFFFFF") await SetWhiteSubstituteColor(adapter, Group);

			await SetColorMode(adapter, Group); //Nach anschalten Colormode setzen

			if (color == "#FFFFFF") await SetCt(adapter, Group, ct); //Nach anschalten Ct setzen
		}
	} catch (error) {
		adapter.errorHandling(error, "PowerOnAftercare");
	}
}

module.exports = {
	SetBrightness,
	SetColor,
	SetColorMode,
	SetCt,
	SetWhiteSubstituteColor,
	AdaptiveCt,
	AdaptiveBri,
	setDeviceBri,
	PowerOnAftercare,
};
