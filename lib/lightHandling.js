/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable indent */
"use strict";
const SunCalc = require("suncalc2");
const getAstroDate = require("./helper").getAstroDate;
const compareTime = require("./helper").compareTime;
const { getDateObject } = require("./helper");
const colorConv = require("./colorCoversation");

/**
 * SetBrightness
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number | undefined} Brightness Value 0 to 100
 */
async function SetBrightness(adapter, Group, Brightness) {
	try {
		adapter.writeLog(`Reaching SetBrightness, Group="${Group}" Brightness="${Brightness}`);
		const LightGroups = adapter.LightGroups;

		//Brightness = Math.min(Math.max(typeof Brightness === "number" ? Brightness : 0, 2), 100);

		if (LightGroups[Group].power) {
			await setDeviceBri(adapter, Group, Brightness);
		}

		await adapter.setStateAsync(Group + "." + "bri", Brightness, true);
		return true;
	} catch (e) {
		adapter.log.error(`SetBrightness => ${e}`);
	}
}

/**
 * AdaptiveBri
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function AdaptiveBri(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;
		adapter.log.debug(
			`Reaching AdaptiveBri for Group="${Group}" actual Lux="${LightGroups[Group].actualLux}" generic lux="${adapter.ActualGenericLux}`,
		);

		let TempBri = 0;

		if (LightGroups[Group].adaptiveBri) {
			if (LightGroups[Group].actualLux === 0) {
				TempBri = parseInt(adapter.GlobalSettings.minBri);
			} else if (LightGroups[Group].actualLux >= 10000) {
				TempBri = 100;
			} else if (LightGroups[Group].actualLux > 0 && LightGroups[Group].actualLux < 10000) {
				TempBri = LightGroups[Group].actualLux / 100;

				if (TempBri < adapter.GlobalSettings.minBri) TempBri = parseInt(adapter.GlobalSettings.minBri);
			}
		}
		return Math.round(TempBri);
	} catch (e) {
		adapter.log.error(`AdaptiveBri => ${e}`);
	}
}

/**
 * setDeviceBri
 * @description Subfunktion for setBri, is setting directly the brightness of devices
 * @param {object} adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 * @param {number | undefined} Brightness Value 0 to 100
 */
async function setDeviceBri(adapter, Group, Brightness) {
	try {
		const LightGroups = adapter.LightGroups;

		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`setDeviceBri => Not able to set Brighness for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		for (const Light in LightGroups[Group].lights) {
			if (LightGroups[Group].lights[Light].bri) {
				if (LightGroups[Group].lights[Light].bri.oid !== "") {
					if (LightGroups[Group].lights[Light].power) {
						if (LightGroups[Group].lights[Light].power.oid !== "") {
							Brightness = Math.min(Math.max(typeof Brightness === "number" ? Brightness : 0, 2), 100);
							adapter.writeLog(
								`setDeviceBri => Power State is available. Min. Brightness is set to 2%. Actual Brightness = "${Brightness}"`,
							);
						}
					}

					await adapter.setForeignStateAsync(
						LightGroups[Group].lights[Light].bri.oid,
						// @ts-ignore
						Math.round((Brightness / 100) * LightGroups[Group].lights[Light].bri.defaultBri),
						false,
					);
				}
			}
		}
	} catch (e) {
		adapter.writeLog(`setDeviceBri => ${e}`, "error");
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
				`setDeviceBri => Not able to set Color-Temperature for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		adapter.writeLog(`Reaching SetCt, Group="${Group}" Ct="${LightGroups[Group].ct}"`);

		if (LightGroups[Group].power) {
			for (const Light in LightGroups[Group].lights) {
				if (LightGroups[Group].lights[Light].ct) {
					if (LightGroups[Group].lights[Light].ct.oid !== "") {
						const TempCt =
							LightGroups[Group].lights[Light].ct.minVal < 1000
								? await ConvertKelvin(
										adapter,
										LightGroups[Group].lights[Light].ct.minVal,
										LightGroups[Group].lights[Light].ct.maxVal,
										ct,
								  )
								: ct;
						await adapter.setForeignStateAsync(LightGroups[Group].lights[Light].ct.oid, TempCt, false);
					}
				}
			}
		}

		await adapter.setStateAsync(Group + ".ct", LightGroups[Group].ct, true);

		return true;
	} catch (e) {
		adapter.log.error(`SetCt => ${e}`);
	}
}

/**
 * ConvertKelvin
 * @param {object} adapter Adapter-Class
 * @param {number} MinVal
 * @param {number} MaxVal
 * @param {number} Ct
 */
async function ConvertKelvin(adapter, MinVal, MaxVal, Ct) {
	try {
		const KelvinRange = adapter.GlobalSettings.maxCt - adapter.GlobalSettings.minCt;
		const ValRange = MaxVal - MinVal;

		const KelvinProz = (Ct - adapter.GlobalSettings.minCt) / (KelvinRange / 100);
		const ValProz = ValRange / 100;
		const ConvertedCt = Math.round(ValProz * KelvinProz + MinVal);

		return ConvertedCt;
	} catch (e) {
		adapter.log.error(`ConvertKelvin => ${e}`);
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
		let adaptiveCtTimed = minCt;

		const sunsetDate = await getAstroDate(adapter, "sunset", undefined); //Sonnenuntergang
		const sunriseDate = await getAstroDate(adapter, "sunrise", undefined); //Sonnenaufgang
		const solarNoonDate = await getAstroDate(adapter, "solarNoon", undefined); //Höchster Sonnenstand (Mittag)

		adapter.writeLog(
			`[ AdaptiveCt // getAstroDate] sunsetDate="${sunsetDate}", sunriseDate="${sunriseDate}", solarNoonDate="${solarNoonDate}"`,
		);

		const sunset = sunsetDate.getTime(); //Sonnenuntergang
		const sunrise = sunriseDate.getTime(); //Sonnenaufgang
		const solarNoon = solarNoonDate.getTime(); //Höchster Sonnenstand (Mittag)

		adapter.writeLog(
			`[ AdaptiveCt ] minCT="${minCt}", maxCt="${maxCt}", sunset="${sunset}", sunrise="${sunrise}", solarNoon="${solarNoon}"`,
		);

		let morningTime = 0;

		let sunMinutesDay = (sunset - sunrise) / 1000 / 60;
		let RangePerMinute = CtRange / sunMinutesDay;

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

		adapter.writeLog(
			`[ AdaptiveCt ] adaptiveCtLinear="${adaptiveCtLinear}" adaptiveCtSolar="${adaptiveCtSolar}" adaptiveCtSolarInterpolated="${adaptiveCtSolarInterpolated}" adaptiveCtTimed="${adaptiveCtTimed}`,
		);

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
						sunMinutesDay = (sunset - morningTime) / 1000 / 60;
						RangePerMinute = CtRange / sunMinutesDay;

						adapter.writeLog(
							`[ AdaptiveCt // timed ] morningTime="${morningTime}", sunMinutesDay="${sunMinutesDay}", RangPerMinute="${RangePerMinute}"`,
						);

						if (await compareTime(adapter, morningTime, sunset, "between", ActualTime)) {
							//   log("Absteigend von Morgens bis Abends")
							adaptiveCtTimed = Math.round(
								maxCt - ((ActualTime - morningTime) / 1000 / 60) * RangePerMinute,
							);
						}

						await adapter.setStateAsync(Group + ".ct", adaptiveCtTimed, false);
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

		adapter.log.debug(
			`Reaching WhiteSubstituteColor for Group="${Group}" = "${LightGroups[Group].description}" LightGroups[Group].power="${LightGroups[Group].power}" LightGroups[Group].color="${LightGroups[Group].color}`,
		);

		if (LightGroups[Group].power && LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
			//Nur ausführen bei anschalten und Farbe weiß

			// log("anschalten und Farbe weiß")
			if (
				LightGroups[Group].ct < (maxCt - minCt) / 4 + minCt ||
				LightGroups[Group].ct > ((maxCt - minCt) / 4) * 3 + minCt
			) {
				//Ct Regelbereich vierteln, erstes viertel ist ww, 2tes und drittes wieder kw, das letzte ww

				for (const Light in LightGroups[Group].lights) {
					if (LightGroups[Group].lights[Light].ct && LightGroups[Group].lights[Light].color) {
						if (
							LightGroups[Group].lights[Light].ct.oid === "" &&
							LightGroups[Group].lights[Light].color.oid !== "" &&
							LightGroups[Group].lights[Light].color.warmWhiteColor !== "" &&
							LightGroups[Group].lights[Light].color.dayLightColor !== ""
						) {
							await adapter.setForeignStateAsync(
								LightGroups[Group].lights[Light].color.oid,
								LightGroups[Group].lights[Light].color.warmWhiteColor,
								false,
							);
						}
					}
				}
			} else {
				//  log("Kaltweiss")
				for (const Light in LightGroups[Group].lights) {
					if (LightGroups[Group].lights[Light].ct && LightGroups[Group].lights[Light].color) {
						if (
							LightGroups[Group].lights[Light].ct.oid === "" &&
							LightGroups[Group].lights[Light].color.oid !== "" &&
							LightGroups[Group].lights[Light].color.warmWhiteColor !== "" &&
							LightGroups[Group].lights[Light].color.dayLightColor !== ""
						) {
							await adapter.setForeignStateAsync(
								LightGroups[Group].lights[Light].color.oid,
								LightGroups[Group].lights[Light].color.dayLightColor,
								false,
							);
						}
					}
				}
			}
		}
	} catch (e) {
		adapter.log.error(`SetWhiteSubstituteColor => ${e}`);
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
		adapter.log.debug(`Reaching SetColorMode for Group="${Group}"`);

		if (LightGroups[Group].power) {
			for (const Light in LightGroups[Group].lights) {
				//Alle Lampen der Gruppe durchgehen
				if (LightGroups[Group].lights[Light].modeswitch) {
					if (LightGroups[Group].lights[Light].modeswitch.oid !== "") {
						//Prüfen ob Datenpunkt für Colormode vorhanden

						if (LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
							//bei Farbe weiss

							await adapter.setForeignStateAsync(
								LightGroups[Group].lights[Light].modeswitch.oid,
								LightGroups[Group].lights[Light].modeswitch.whiteModeVal,
								false,
							);
							adapter.writeLog(
								`Device="${LightGroups[Group].lights[Light].modeswitch.oid}" Val="${LightGroups[Group].lights[Light].modeswitch.whiteModeVal}`,
								"info",
							);
						} else {
							//Bei allen anderen Farben

							await adapter.setForeignStateAsync(
								LightGroups[Group].lights[Light].modeswitch.oid,
								LightGroups[Group].lights[Light].modeswitch.colorModeVal,
								false,
							);
						}
					}
				}
			}
		}
		return true;
	} catch (e) {
		adapter.log.error(`SetColorMode => ${e}`);
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
		adapter.log.debug(
			`Reaching SetColor for Group="${Group}" power="${LightGroups[Group].power}" Color="${Color}"`,
		);

		if (!LightGroups[Group].lights.length) {
			adapter.writeLog(
				`setColor => Not able to set Color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const rgbTemp = await colorConv.ConvertHexToRgb(Color);

		if (LightGroups[Group].power) {
			for (const Light in LightGroups[Group].lights) {
				if (LightGroups[Group].lights[Light].color) {
					if (LightGroups[Group].lights[Light].color.oid != "") {
						//Prüfen ob Datenpunkt für Color vorhanden

						switch (LightGroups[Group].lights[Light].color.colorType) {
							case "hex": //Keine Konvertierung nötig
								await adapter.setForeignStateAsync(
									LightGroups[Group].lights[Light].color.oid,
									Color,
									false,
								);
								break;
							case "rgb":
								await adapter.setForeignStateAsync(
									LightGroups[Group].lights[Light].color.oid,
									rgbTemp,
									false,
								);
								break;
							case "xy":
								await adapter.setForeignStateAsync(
									LightGroups[Group].lights[Light].color.oid,
									await colorConv.ConvertRgbToXy(rgbTemp),
									false,
								);
								break;
							default:
								adapter.writeLog(
									`SetColor: Unknown colorType = "${LightGroups[Group].lights[Light].color.colorType}" in Group="${Group}", please specify!`,
									"warn",
								);
						}
					}
				}
			}
			await adapter.setStateAsync(Group + ".color", LightGroups[Group].color, true);
			return true;
		} else {
			return false;
		}
	} catch (e) {
		adapter.writeLog(`SetColor => ${e}`, "error");
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
		adapter.log.info(`Reaching powerOnAfterCare for Group="${Group}" bri="${bri}" ct="${ct}" color="${color}"`);

		if (LightGroups[Group].power) {
			//Nur bei anschalten ausführen

			if (!LightGroups[Group].rampOn.enabled) {
				//Wenn kein RampOn Helligkeit direkt setzen

				if (LightGroups[Group].adaptiveBri) {
					//Bei aktiviertem AdaptiveBri
					await SetBrightness(adapter, Group, await AdaptiveBri(adapter, Group));
				} else {
					adapter.log.info(`Now setting bri to ${bri}% for Group="${Group}"`);
					await SetBrightness(adapter, Group, bri);
				}
			}

			await SetColor(adapter, Group, color); //Nach anschalten Color setzen

			if (color == "#FFFFFF") await SetWhiteSubstituteColor(adapter, Group);

			await SetColorMode(adapter, Group); //Nach anschalten Colormode setzen

			if (color == "#FFFFFF") await SetCt(adapter, Group, ct); //Nach anschalten Ct setzen
		}
	} catch (e) {
		adapter.writeLog(`PowerOnAftercare => ${e}`, "error");
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
