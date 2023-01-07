/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable indent */
"use strict";
const suncalc = require("suncalc");
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
 */
async function SetBrightness(adapter, Group, Brightness) {
	adapter.writeLog(`[ SetBrightness ] Reaching for Group="${Group}" Brightness="${Brightness}`);

	try {
		const LightGroups = adapter.LightGroups;

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
					setDeviceBri(adapter, Light, Brightness);
				}
			}
		}

		await adapter.setStateAsync(Group + "." + "bri", Brightness, true);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetBrightness");
	}
}

/**
 * setDeviceBri
 * @description Subfunktion for setBri, is setting directly the brightness of devices
 * @param {object} adapter Adapter-Class
 * @param {object} Light Light Array
 * @param {number | undefined} Brightness Value 0 to 100
 */
async function setDeviceBri(adapter, Light, Brightness) {
	try {
		if (!Light?.bri?.sendBri) {
			adapter.writeLog(
				`[ setDeviceBri ] Switching with Power State is activated. Min. Brightness is defined with 2%. Actual Brightness = "${Brightness}"`,
			);

			Brightness = Math.min(Math.max(typeof Brightness === "number" ? Brightness : 0, 2), 100);
		} else {
			adapter.writeLog(
				`[ setDeviceBri ] Switching with Brightness is activated. No min. Brightness needed. Actual Brightness = "${Brightness}"`,
			);

			Brightness = typeof Brightness === "number" ? Brightness : 0;
		}

		await adapter.setForeignStateAsync(Light.bri.oid, Math.round((Brightness / 100) * Light.bri.defaultBri), false);
		return true;
	} catch (error) {
		adapter.errorHandling(error, "setDeviceBri");
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

		if (LightGroups[Group].power) {
			for (const Light of LightGroups[Group].lights) {
				if (Light?.ct?.oid) {
					const TempCt =
						Light.ct.minVal < 1000
							? await ConvertKelvin(adapter, Light.ct.minVal, Light.ct.maxVal, ct)
							: ct;
					await adapter.setForeignStateAsync(Light.ct.oid, TempCt, false);
				}
			}
		}

		await adapter.setStateAsync(Group + ".ct", LightGroups[Group].ct, true);

		return true;
	} catch (error) {
		adapter.errorHandling(error, "SetCt");
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
		const KelvinRange = adapter.Settings.maxCt - adapter.Settings.minCt;
		const ValRange = MaxVal - MinVal;

		const KelvinProz = (Ct - adapter.Settings.minCt) / (KelvinRange / 100);
		const ValProz = ValRange / 100;
		const ConvertedCt = Math.round(ValProz * KelvinProz + MinVal);

		return ConvertedCt;
	} catch (error) {
		adapter.errorHandling(error, "ConvertKelvin");
	}
}

/**
 * AdapticeCt
 * @param {object} adapter Adapter-Class
 */
async function AdaptiveCt(adapter) {
	try {
		const LightGroups = adapter.LightGroups;

		const ActualTime = new Date().getTime();

		const minCt = adapter.Settings.minCt;
		const maxCt = adapter.Settings.maxCt;
		const CtRange = maxCt - minCt;

		let adaptiveCtLinear = 0;
		let adaptiveCtSolar = 0;
		let adaptiveCtSolarInterpolated = 0;
		let adaptiveCtTimed = 0;

		const sunset = adapter.getAstroDate("sunset").getTime();
		const sunrise = adapter.getAstroDate("sunrise").getTime();
		const solarNoon = adapter.getAstroDate("solarNoon").getTime();
		let morningTime = 0;

		let sunMinutesDay = (sunset - sunrise) / 1000 / 60;
		let RangePerMinute = CtRange / sunMinutesDay;

		const now = new Date();
		const sunpos = suncalc.getPosition(now, adapter.lat, adapter.lng);
		const sunposNoon = suncalc.getPosition(solarNoon, adapter.lat, adapter.lng);

		if (adapter.compareTime(sunrise, solarNoon, "between")) {
			//   log("Aufsteigend")
			adaptiveCtLinear = Math.round(minCt + ((ActualTime - sunrise) / 1000 / 60) * RangePerMinute * 2); // Linear = ansteigende Rampe von Sonnenaufgang bis Sonnenmittag, danach abfallend bis Sonnenuntergang
		} else if (adapter.compareTime(solarNoon, sunset, "between")) {
			//   log("Absteigend")
			adaptiveCtLinear = Math.round(maxCt - ((ActualTime - solarNoon) / 1000 / 60) * RangePerMinute * 2);
		}

		if (adapter.compareTime(sunrise, sunset, "between")) {
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
						morningTime = adapter.getDateObjectA(LightGroups[Group].adaptiveCtTime).getTime();
						sunMinutesDay = (sunset - morningTime) / 1000 / 60;
						RangePerMinute = CtRange / sunMinutesDay;

						if (adapter.compareTime(morningTime, sunset, "between")) {
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

		if (LightGroups[Group].power && LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
			//Nur ausführen bei anschalten und Farbe weiß

			// log("anschalten und Farbe weiß")
			if (
				LightGroups[Group].ct < (maxCt - minCt) / 4 + minCt ||
				LightGroups[Group].ct > ((maxCt - minCt) / 4) * 3 + minCt
			) {
				//Ct Regelbereich vierteln, erstes viertel ist ww, 2tes und drittes wieder kw, das letzte ww

				for (const Light of LightGroups[Group].lights) {
					if (Light.ct && Light.color) {
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
					if (Light.ct && Light.color) {
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

		if (LightGroups[Group].power) {
			for (const Light of LightGroups[Group].lights) {
				//Alle Lampen der Gruppe durchgehen
				if (Light.modeswitch) {
					if (Light?.modeswitch?.oid) {
						//Prüfen ob Datenpunkt für Colormode vorhanden

						if (LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
							//bei Farbe weiss

							await adapter.setForeignStateAsync(
								Light.modeswitch.oid,
								Light.modeswitch.whiteModeVal,
								false,
							);
							adapter.writeLog(
								`[ SetColorMode ] Device="${Light.modeswitch.oid}" Val="${Light.modeswitch.whiteModeVal}`,
								"info",
							);
						} else {
							//Bei allen anderen Farben

							await adapter.setForeignStateAsync(
								Light.modeswitch.oid,
								Light.modeswitch.colorModeVal,
								false,
							);
						}
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

		if (LightGroups[Group].power) {
			for (const Light of LightGroups[Group].lights) {
				if (Light.color) {
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
		} else {
			return false;
		}
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
