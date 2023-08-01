"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require("@iobroker/adapter-core");

// eslint-disable-next-line no-unused-vars
const helper = require("./lib/helper");

const SunCalc = require("suncalc2");
const { compareTime, getDateObject, convertTime, getAstroDate } = require("./lib/helper");
const converters = require("./lib/converters");
const { params } = require("./lib/params");
const { DeviceTemplate, DeviceAllTemplate } = require(`./lib/groupTemplates`);
const {
	TestTemplateLamps,
	TestTemplateMotionSensors,
	TestTemplateLuxSensors,
	TestTemplatePresence,
} = require(`./lib/testTemplates`);

//const { objects } = require("./lib/objects");

class Lightcontrol extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "lightcontrol",
		});

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
		this.LightGroups = {};
		this.LuxSensors = [];
		this.MotionSensors = [];

		this.activeStates = []; // Array of activated states for LightControl

		this.ActualGenericLux = 0;
		this.ActualPresence = true;
		this.ActualPresenceCount = { newVal: 1, oldVal: 1 };

		this.RampIntervalObject = {};
		this.TransitionTimeoutObject = {};
		this.AutoOffTimeoutObject = {};
		this.AutoOffNoticeTimeoutObject = {};
		this.BlinkIntervalObj = {};

		this.lat = "";
		this.lng = "";

		this.DevMode = false;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		this.writeLog(`[ onReady ] LightGroups from Settings: ${JSON.stringify(this.config?.LightGroups)}`);

		//Create LightGroups Object from GroupNames
		await this.CreateLightGroupsObject();

		//Create all States, Devices and Channels
		if (Object.keys(this.LightGroups).length !== 0) {
			await this.InitAsync();
		} else {
			this.writeLog(`[ onReady ] No Init because no LightGroups defined in settings`, "warn");
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.clearRampIntervals(null);
			this.clearTransitionTimeout(null);
			this.clearBlinkIntervals(null);
			this.clearAutoOffTimeouts(null);
			if (this.TickerIntervall) clearTimeout(this.TickerIntervall), (this.TickerIntervall = null);

			callback();
		} catch (error) {
			this.writeLog(`[ onUnload ] Error by unload. Error: ${error}`, "error");
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (!id || !state || this.isInit) {
			return;
		}
		const ids = id.split(".");

		if (state.val !== null) {
			this.writeLog(`[ onStateChange ] state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (ids[0] === "lightcontrol" && !state.ack) {
				const NewVal = state.val;
				let OldVal;

				const OwnId = helper.removeNamespace(this.namespace, id);
				const { Group, Prop } = helper.ExtractGroupAndProp(OwnId);

				if (!Object.prototype.hasOwnProperty.call(this.LightGroups, Group)) {
					this.writeLog(`Group "${Group}" not defined in LightGroups! Please check your settings!`, "warn");
					return;
				}

				if (Prop === "power" && Group !== "All") {
					OldVal = this.LightGroups[Group].powerOldVal = this.LightGroups[Group].powerNewVal;
					this.LightGroups[Group].powerNewVal = NewVal;
				}

				if (Group === "All") {
					await this.SetMasterPowerAsync(NewVal);
				} else {
					await this.ControllerAsync(Group, Prop, NewVal, OldVal, OwnId);
				}
			} else if (ids[0] !== "lightcontrol" && state.ack) {
				//Handle External States
				this.writeLog(`[ onStateChange ] ExternalState, id="${id}"`);

				//Check if it's a LuxSensor
				if (this.LuxSensors.includes(id)) {
					const groupsWithLuxSensor = Object.values(this.LightGroups).filter(
						(Group) => Group.LuxSensor === id,
					);

					for (const Group of groupsWithLuxSensor) {
						if (state.val !== Group.actualLux) {
							this.writeLog(
								`[ onStateChange ] It's a LuxSensor in following Group: ${Group.description} with value = ${state.val} (old value = ${Group.actualLux})`,
							);
							Group.actualLux = state.val;
							await this.ControllerAsync(Group.description, "actualLux", state.val, Group.actualLux, "");
						}
					}

					//Check if it's a MotionSensor
				} else if (this.MotionSensors.includes(id)) {
					await Promise.all(
						Object.keys(this.LightGroups)
							.filter((Group) => Group !== "All")
							.flatMap((Group) => {
								const sensors = this.LightGroups[Group].sensors;
								if (Array.isArray(sensors)) {
									return sensors
										.filter((sensor) => sensor.oid === id)
										.map(async (sensor) => {
											const motionValue = state.val === sensor.motionVal;
											sensor.isMotion = motionValue;

											this.writeLog(
												`[onStateChange] Sensor in Group="${Group}". This isMotion="${motionValue}"`,
											);

											await this.SummarizeSensorsAync(Group);
										});
								} else {
									this.writeLog(
										`[onStateChange] Sensors in Group="${Group}" is not iterable. Please check your config!`,
										"warn",
									);
									return [];
								}
							}),
					);

					//Check if it's Presence
				} else if (this.config.IsPresenceDp === id) {
					this.writeLog(`[ onStateChange ] It's IsPresenceDp: ${id}`);

					this.ActualPresence = typeof state.val === "boolean" ? state.val : false;
					await this.AutoOnPresenceIncreaseAsync();

					//Check if it's Presence Counter
				} else if (this.config.PresenceCountDp === id) {
					this.writeLog(`[ onStateChange ] It's PresenceCountDp: ${id}`);

					this.ActualPresenceCount.oldVal = this.ActualPresenceCount.newVal;
					this.ActualPresenceCount.newVal = typeof state.val === "number" ? state.val : 0;

					if (this.ActualPresenceCount.newVal > this.ActualPresenceCount.oldVal) {
						this.writeLog(
							`[ onStateChange ] PresenceCountDp value is greater than old value: ${state.val}`,
						);
						await this.AutoOnPresenceIncreaseAsync();
					}
				}
			}
		} else {
			// The state was deleted
			this.writeLog(`[ onStateChange ] state ${id} deleted`);
		}
	}

	/**
	 * Is called from onStateChange
	 * @async
	 * @param {string} Group Any Group of Lightgroups
	 * @param {string} prop1 Which State has changed
	 * @param {any} NewVal New Value of Datapoint
	 * @param {any} OldVal Old Value of Datapoint
	 * @param {string} id Object-ID
	 */
	async ControllerAsync(Group, prop1, NewVal, OldVal, id = "") {
		let handeled = false;

		this.writeLog(
			`[ Controller ] Reaching, Group="${Group}" Property="${prop1}" NewVal="${NewVal}", ${
				OldVal === undefined ? "" : "OldVal=" + OldVal
			}"`,
			"info",
		);

		if (prop1 !== "power") await this.SetValueToObjectAsync(Group, prop1, NewVal);

		switch (prop1) {
			case "actualLux":
				if (!this.LightGroups[Group].powerCleaningLight) {
					//Autofunktionen nur wenn Putzlicht nicht aktiv
					await this.AutoOnLuxAsync(Group);
					await this.AutoOffLuxAsync(Group);
					if (this.LightGroups[Group].adaptiveBri)
						await this.SetBrightnessAsync(Group, await this.AdaptiveBriAsync(Group));
					await this.AutoOnMotionAsync(Group);
				}
				handeled = true;
				break;
			case "isMotion":
				if (!this.LightGroups[Group].powerCleaningLight) {
					if (this.LightGroups[Group].isMotion && this.LightGroups[Group].power) {
						//AutoOff Timer wird nach jeder Bewegung neugestartet
						await this.AutoOffTimedAsync(Group);
					}

					await this.AutoOnMotionAsync(Group);
				}
				handeled = true;
				break;
			case "rampOn.enabled":
				break;
			case "rampOn.switchOutletsLast":
				break;
			case "rampOn.time":
				break;
			case "rampOff.enabled":
				break;
			case "rampOff.switchOutletsLast":
				break;
			case "autoOffTimed.enabled":
				break;
			case "autoOffTimed.autoOffTime":
				break;
			case "autoOffTimed.noAutoOffWhenMotion":
				break;
			case "autoOffTimed.noAutoOffWhenMotionMode":
				break;
			case "autoOnMotion.enabled":
				break;
			case "autoOnMotion.minLux":
				break;
			case "autoOnMotion.bri":
				break;
			case "autoOnMotion.color":
				break;
			case "autoOffLux.enabled":
				break;
			case "autoOffLux.operator":
				break;
			case "autoOffLux.minLux":
				break;
			case "autoOffLux.switchOnlyWhenPresence":
				break;
			case "autoOffLux.switchOnlyWhenNoPresence":
				await this.AutoOffLuxAsync(Group);
				handeled = true;
				break;
			case "autoOnLux.enabled":
				break;
			case "autoOnLux.operator":
				break;
			case "autoOnLux.switchOnlyWhenNoPresence":
				break;
			case "autoOnLux.switchOnlyWhenPresence":
				break;
			case "autoOnLux.minLux":
				break;
			case "autoOnLux.bri":
				this.AutoOnLuxAsync(Group);
				handeled = true;
				break;
			case "autoOnPresenceIncrease.enabled":
				break;
			case "autoOnPresenceIncrease.bri":
				break;
			case "autoOnPresenceIncrease.color":
				break;
			case "autoOnPresenceIncrease.minLux":
				await this.AutoOnPresenceIncreaseAsync();
				handeled = true;
				break;
			case "adaptiveCt.enabled":
				break;
			case "adaptiveCt.adaptiveCtMode":
				break;
			case "adaptiveCt.adaptiveCtTime":
				break;
			case "bri":
				await this.SetBrightnessAsync(Group, this.LightGroups[Group].bri);
				handeled = true;
				break;
			case "ct":
				await this.SetCtAsync(Group, this.LightGroups[Group].ct);
				await this.SetWhiteSubstituteColorAsync(Group);
				handeled = true;
				break;
			case "color":
				if (helper.CheckHex(NewVal)) {
					this.LightGroups[Group].color = NewVal.toUpperCase();
					await this.SetColorAsync(Group, this.LightGroups[Group].color);
					if (this.LightGroups[Group].color == "#FFFFFF") await this.SetWhiteSubstituteColorAsync(Group);
					await this.SetColorModeAsync(Group);
				}
				handeled = true;
				break;
			case "transitionTime":
				await this.SetTtAsync(Group, helper.limitNumber(NewVal, 0, 64000), prop1);
				handeled = true;
				break;
			case "power":
				if (NewVal !== OldVal) {
					await this.GroupPowerOnOffAsync(Group, NewVal); //Alles schalten
					if (NewVal) await this.PowerOnAftercareAsync(Group);
					if (!NewVal && this.LightGroups[Group].autoOffTimed.enabled) {
						//Wenn ausschalten und autoOffTimed ist aktiv, dieses löschen, da sonst erneute ausschaltung nach Ablauf der Zeit. Ist zusätzlich rampon aktiv, führt dieses zu einem einschalten mit sofort folgenden ausschalten
						await this.clearAutoOffTimeouts(Group);
					}
					if (!NewVal && this.LightGroups[Group].powerCleaningLight) {
						//Wenn via Cleaninglight angeschaltet wurde, jetzt aber normal ausgeschaltet, powerCleaningLight synchen um Blockade der Autofunktionen zu vermeiden
						this.LightGroups[Group].powerCleaningLight = false;
						await this.setStateAsync(Group + ".powerCleaningLight", false, true);
					}
				}
				handeled = true;
				break;
			case "powerCleaningLight":
				await this.GroupPowerCleaningLightOnOffAsync(Group, NewVal);
				handeled = true;
				break;
			case "adaptiveBri":
				await this.SetBrightnessAsync(Group, await this.AdaptiveBriAsync(Group));
				handeled = true;
				break;
			case "dimmUp":
				await this.setStateAsync(
					Group + "." + "bri",
					Math.min(Math.max(this.LightGroups[Group].bri + this.LightGroups[Group].dimmAmount, 10), 100),
					false,
				);
				handeled = true;
				break;
			case "dimmDown":
				await this.setStateAsync(
					Group + "." + "bri",
					Math.min(Math.max(this.LightGroups[Group].bri - this.LightGroups[Group].dimmAmount, 2), 100),
					false,
				);
				handeled = true;
				break;
			case "dimmAmount":
				break;
			case "blink.blinks":
				break;
			case "blink.frequency":
				break;
			case "blink.bri":
				break;
			case "blink.color":
				break;
			case "blink.enabled":
				if (NewVal && NewVal !== OldVal) {
					await this.SetValueToObjectAsync(Group, ["blink.infinite", "blink.stop"], [true, false]);
					await this.BlinkAsync(Group);
				} else if (!NewVal) {
					await this.SetValueToObjectAsync(Group, "blink.stop", true);
				}
				handeled = true;
				break;
			case "blink.start":
				await this.SetValueToObjectAsync(Group, ["blink.stop", "blink.infinite"], false);
				await this.BlinkAsync(Group);
				break;
			default:
				this.writeLog(`[ Controller ] Error, unknown or missing property: "${prop1}"`, "warn");
				handeled = true;
		}

		if (!handeled) {
			if (id !== "") {
				await this.setStateAsync(id, NewVal, true);
			}
		}
		return true;
	}

	/**
	 * Is called if an object changes to ensure (de-) activation of calculation or update configuration settings
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	async onObjectChange(id, obj) {
		if (!id || !obj || this.isInit) {
			return;
		}
		const stateID = id;

		// Check if object is activated for LightControl
		if (obj && obj.common) {
			// Verify if custom information is available regarding LightControl
			if (obj.common.custom && obj.common.custom[this.namespace] && obj.common.custom[this.namespace].enabled) {
				//Check if its an own Lightcontrol State
				if (stateID.includes(this.namespace)) {
					await this.deactivateOwnIdAsync(stateID);
				} else {
					this.writeLog(
						`[ onObjectChange ] Object array of LightControl activated state changed : ${JSON.stringify(
							obj,
						)} stored Objects : ${JSON.stringify(this.activeStates)}`,
					);

					// Verify if the object was already activated, if not initialize new parameter
					if (!this.activeStates.includes(stateID)) {
						this.writeLog(`[ onObjectChange ] Enable LightControl for : ${stateID}`, "info");
						await this.checkLightGroupParameterAsync(stateID);

						if (!this.activeStates.includes(stateID)) {
							this.writeLog(
								`[ onObjectChange ] Cannot enable LightControl for ${stateID}, check settings and error messages`,
								"warn",
							);
						}
					} else {
						this.writeLog(`[ onObjectChange ] Updating LightControl configuration for : ${stateID}`);
						//Cleaning LightGroups from ID and set it new
						this.deleteStateIdFromLightGroups(stateID);
						await this.checkLightGroupParameterAsync(stateID);

						if (!this.activeStates.includes(stateID)) {
							this.writeLog(
								`[ onObjectChange ] Cannot update LightControl configuration for ${stateID}, check settings and error messages`,
								"warn",
							);
						}
					}
				}
			} else if (this.activeStates.includes(stateID)) {
				this.activeStates = helper.removeValue(this.activeStates, stateID);
				this.writeLog(`[ onObjectChange ] Disabled LightControl for : ${stateID}`, "info");

				this.deleteStateIdFromLightGroups(stateID);

				this.writeLog(
					`[ onObjectChange ] Active state array after deactivation of ${stateID} : ${
						this.activeStates.length === 0 ? "empty" : JSON.stringify(this.activeStates)
					}`,
				);
				this.writeLog(
					`[ onObjectChange ] LightGroups after deactivation of ${stateID} : ${JSON.stringify(
						this.LightGroups,
					)}`,
				);
				this.unsubscribeForeignStates(stateID);
			}
		} else {
			// Object change not related to this adapter, ignoring
		}
	}

	/**
	 * Is called if a message is comming
	 */
	async onMessage(msg) {
		if (this.isInit) {
			return;
		}
		this.writeLog(`[ onMessage ] Incomming Message from: ${JSON.stringify(msg)}`);
		if (msg.callback) {
			switch (msg.command) {
				case "LightGroup": {
					try {
						const groups = [];
						if (Object.keys(this.LightGroups).length !== 0) {
							for (const group of Object.keys(this.LightGroups)) {
								if (group !== "All") {
									groups.push({ value: group, label: group });
								}
							}
						}
						this.sendTo(msg.from, msg.command, groups, msg.callback);
						this.writeLog(`[ onMessage ] LightGroup => LightGroups Callback: ${JSON.stringify(groups)}.`);
					} catch (error) {
						this.writeLog(error, "error", "onMessage // case LightGroup");
					}
					break;
				}

				case "LightName": {
					try {
						const lightGroups = msg.message.LightGroups;
						const DEFAULT_LIGHT = { value: "Example_Light", label: "Example_Light" };

						this.writeLog(
							`[ onMessage ] LightName => getLights for Groups: ${JSON.stringify(lightGroups)}.`,
						);

						const lights = [];

						const lightsSet = new Set();

						if (!lightGroups) {
							return;
						}

						if (Array.isArray(lightGroups)) {
							for (const key of lightGroups) {
								if (Object.prototype.hasOwnProperty.call(this.LightGroups, key)) {
									const group = this.LightGroups[key];
									if (group && group.lights) {
										for (const light of group.lights) {
											if (!lightsSet.has(light.description)) {
												lightsSet.add(light.description);
												lights.push({ value: light.description, label: light.description });
												this.writeLog(
													`[ onMessage ] LightName => Light: ${light.description} in Group: ${key} found.`,
												);
											}
										}
									}
								}
							}
						} else if (Object.prototype.hasOwnProperty.call(this.LightGroups, lightGroups)) {
							// Prüfe, ob lightGroups ein einzelner Schlüssel ist
							const group = this.LightGroups[lightGroups];
							if (group && group.lights) {
								for (const light of group.lights) {
									if (!lightsSet.has(light.description)) {
										lightsSet.add(light.description);
										lights.push({ value: light.description, label: light.description });
										this.writeLog(
											`[ onMessage ] LightName => Light: ${light.description} in Group: ${lightGroups} found.`,
										);
									}
								}
							}
						}

						if (lights.length === 0) {
							lights.push(DEFAULT_LIGHT);
						}
						this.sendTo(msg.from, msg.command, lights, msg.callback);
					} catch (error) {
						this.writeLog(error, "error", `[ onMessage // case LightName ]`);
					}
					break;
				}

				case "checkIdForDuplicates": {
					try {
						this.writeLog(`[ onMessage ] checkcheckIdForDuplicates`);
						this.writeLog(JSON.stringify(msg.message));

						const LightGroups = msg.message.LightGroups;

						if (LightGroups && LightGroups !== undefined) {
							const arr = [];
							for (const Group of LightGroups) {
								arr.push(Group.Group);
							}
							this.writeLog(`[ onMessage ] checkcheckIdForDuplicates: ${arr}`);

							// empty object
							const map = {};
							let result = false;
							for (let i = 0; i < arr.length; i++) {
								// check if object contains entry with this element as key
								if (map[arr[i]]) {
									result = true;
									// terminate the loop
									break;
								}
								// add entry in object with the element as key
								map[arr[i]] = true;
							}
							if (!result) {
								this.writeLog(`[ onMessage ] checkcheckIdForDuplicates: No duplicates.`);
								this.sendTo(msg.from, msg.command, "", msg.callback);
							} else {
								this.writeLog(
									`[ onMessage ] Define LightGroups => checkcheckIdForDuplicates: Duplicate GroupNames found.`,
									"warn",
								);
								this.sendTo(msg.from, msg.command, "labelDuplicateGroup", msg.callback);
							}
						} else {
							this.sendTo(msg.from, msg.command, "", msg.callback);
						}
					} catch (error) {
						this.writeLog(error, "error", "onMessage // case checkIdForDuplicates");
					}
					break;
				}
			}
		}
	}

	// *********************************************
	// *                                           *
	// *           SWITCHING ON/OFF                *
	// *                                           *
	// *********************************************
	/**
	 * GroupPowerOnOff
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async GroupPowerOnOffAsync(Group, OnOff) {
		if (!this.LightGroups[Group].rampOn?.enabled || !this.LightGroups[Group].rampOff?.enabled) {
			this.writeLog(
				`[ GroupPowerOnOff ] No rampOn or rampOff states available for group="${Group}". Please check your config and restart the adapter!!`,
				"warn",
			);
			return;
		}
		if (!this.LightGroups[Group].lights.some((Light) => Light.power?.oid || Light.bri?.oid)) {
			this.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching ${OnOff} for group="${Group}". No lights defined or no power or brightness states are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(
			`[ GroupPowerOnOff ] Reaching for Group="${Group}", OnOff="${OnOff}" rampOn="${
				this.LightGroups[Group].rampOn.enabled
			}" - ${JSON.stringify(this.LightGroups[Group].rampOn)} rampOff="${
				this.LightGroups[Group].rampOff.enabled
			}" - ${JSON.stringify(this.LightGroups[Group].rampOff)}`,
		);

		if (OnOff) {
			this.LightGroups[Group].power = true;
			//
			// ******* Anschalten ohne ramping * //
			//
			if (!this.LightGroups[Group].rampOn.enabled) {
				await this.SimpleGroupPowerOnOffAsync(Group, OnOff);

				if (this.LightGroups[Group].autoOffTimed.enabled) {
					//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
					await this.AutoOffTimedAsync(Group);
				}
			} else {
				await this.TurnOnWithRampingAsync(Group);
			}
		} else {
			// Ausschalten ohne Ramping */
			if (!this.LightGroups[Group].rampOff.enabled) {
				if (this.LightGroups[Group].rampOn.enabled) {
					//Vor dem ausschalten Helligkeit auf 2 (0+1 wird bei manchchen Devices als aus gewertet) um bei rampon nicht mit voller Pulle zu starten
					await this.SetBrightnessAsync(Group, 2, "ramping");
				}

				await this.SimpleGroupPowerOnOffAsync(Group, OnOff);
				this.LightGroups[Group].power = false;
			} else {
				// Ausschalten mit Ramping */
				await this.TurnOffWithRampingAsync(Group);
			}
		}

		await Promise.all([
			this.setStateAsync(Group + ".power", OnOff, true),
			//this.SetLightStateAsync("GroupPowerOnOff"),
		]);
		return true;
	}

	/**
	 * SimpleGroupPowerOnOff
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async SimpleGroupPowerOnOffAsync(Group, OnOff) {
		const operation = OnOff ? "on" : "off";
		if (!this.LightGroups[Group].lights || !this.LightGroups[Group].lights?.length) {
			this.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const outlast = this.OutlastDevicesAsync(this.LightGroups[Group].lights, OnOff);

		const useBrightness = this.LightGroups[Group].lights
			.filter((Light) => Light?.bri?.oid && Light?.bri?.useBri)
			.map(async (Light) => {
				const brightness = this.LightGroups[Group].adaptiveBri
					? await this.AdaptiveBriAsync(Group)
					: this.LightGroups[Group].bri;

				await Promise.all([
					this.setDeviceBriAsync(Light, OnOff ? brightness : 0),
					this.writeLog(
						`[ SimpleGroupPowerOnOff ] Switching ${operation} ${Light.description} (${Light.bri.oid}) with brightness state`,
					),
				]);
			});

		await Promise.all([useBrightness, outlast]);
		return true;
	}

	/**
	 * DeviceSwitch simple lights with no brightness state
	 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async DeviceSwitchAsync(Group, OnOff) {
		this.writeLog(`[ DeviceSwitch ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

		const promises = this.LightGroups[Group].lights
			.filter((Light) => !Light.bri?.oid && Light.power?.oid)
			.map(async (Light) => {
				await Promise.all([
					this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
					this.writeLog(`[ DeviceSwitch ] Switching ${Light.description} (${Light.power.oid}) to: ${OnOff}`),
				]);
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(error, "error", "DeviceSwitchAsync");
			return;
		});
		return true;
	}

	/**
	 * DeviceSwitch lights before ramping (if brightness state available and not use Bri for ramping)
	 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async DeviceSwitchForRampingAsync(Group, OnOff) {
		this.writeLog(`[ DeviceSwitchForRamping ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

		const promises = this.LightGroups[Group].lights
			.filter((Light) => Light?.bri?.oid && !Light?.bri?.useBri && Light?.power?.oid)
			.map((Light) => {
				this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
			});
		await Promise.all(promises).catch((error) => {
			this.writeLog(error, "error", "DeviceSwitchForRampingAsync");
			return;
		});
		return true;
	}

	/**
	 * OutlastDevices simple lights with no brightness state
	 * @description Switch simple lights with no brightness state
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async OutlastDevicesAsync(Lights, OnOff) {
		return Lights.filter((Light) => Light.power?.oid && !Light.bri?.oid).map(async (Light) => {
			await Promise.all([
				this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
				this.writeLog(`[ DOutlastDevices ] Switching ${Light.description} (${Light.power.oid}) to: ${OnOff}`),
			]);
		});
	}

	/**
	 * BrightnessDevicesSwitchPower
	 * @description Switch lights before ramping (if brightness state available and not useBri for ramping)
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async BrightnessDevicesSwitchPowerAsync(Lights, OnOff) {
		return Lights.filter((Light) => Light.power?.oid && Light.bri?.oid && !Light.bri?.useBri).map(async (Light) => {
			await Promise.all([
				this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
				this.writeLog(
					`[ BrightnessDevicesSwitchPower ] Switching ${Light.description} (${Light.bri.oid}) to: ${OnOff}`,
				),
			]);
		});
	}

	/**
	 * BrightnessDevicesWithRampTime
	 * @description Set Brighness to Lights with transission time
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} Brightness true/false from power state
	 * @param {number} RampTime Information about the RampTime
	 */
	async BrightnessDevicesWithRampTimeAsync(Lights, Brightness, RampTime) {
		return Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && Light.tt?.useTt).map(async (Light) => {
			await Promise.all([
				this.setForeignStateAsync(Light.bri.oid, Brightness),
				this.writeLog(
					`[ BrightnessDevicesWithRampTime ] Set ${Light.description} (${Light.bri.oid}) to: ${Brightness} in: ${RampTime}`,
				),
			]);
		});
	}

	/**
	 * RampUp / RampDown with Interval
	 * @description RampUp / RampDown with Interval and not with transission time
	 * @async
	 * @function
	 * @param {string} Group Name oft the Lightgroup
	 * @param {boolean} rampUp RampUp = true; RampDown = false
	 */
	async RampWithIntervalAsync(Group, rampUp = true) {
		const Lights = this.LightGroups[Group]?.lights || [];
		if (!this.config?.RampSteps) {
			this.writeLog(
				`[ RampWithInterval ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.config.RampSteps ?? 10;
		const RampTime = helper.limitNumber(this.LightGroups[Group].rampOn?.time, 10);
		let LoopCount = 0;

		this.RampIntervalObject[Group] = this.setInterval(async () => {
			LoopCount++;

			const promises = Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && !Light.tt?.useTt).map(
				async (Light) => {
					try {
						await this.setForeignStateAsync(
							Light.bri.oid,
							rampUp
								? Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100))
								: this.LightGroups[Group].bri -
										this.LightGroups[Group].bri / RampSteps -
										Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
						);
					} catch (error) {
						this.writeLog(`[ RampWithInterval ] Not able to set state-id="${Light.bri.oid}"!`, "warn");
						return;
					}
				},
			);

			if (promises.length)
				await Promise.all(promises).catch((error) => {
					this.writeLog(error, "error", "RampWithIntervalAsync");
					return;
				});

			//Interval stoppen und einfache Lampen schalten
			if (LoopCount >= RampSteps || !promises.length) {
				await this.clearRampIntervals(Group);
				return true;
			}
		}, Math.round(RampTime / RampSteps) * 1000);
		return true;
	}

	/**
	 * TurnOnWithRamping
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async TurnOnWithRampingAsync(Group) {
		const funcName = "TurnOnWithRamping";
		if (!this.config?.RampSteps) {
			this.writeLog(
				`[ ${funcName} ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.config.RampSteps;
		let LoopCount = 0;
		//
		// ******* Anschalten mit ramping * //
		//
		await this.clearRampIntervals(Group);
		if (this.LightGroups[Group]?.rampOn?.enabled && this.LightGroups[Group].rampOn?.switchOutletsLast) {
			this.writeLog(`[ ${funcName} ] Switch off with ramping and simple lamps last for Group="${Group}"`);

			await this.BrightnessDevicesSwitchPowerAsync(this.LightGroups[Group].lights, true); // Turn on lights for ramping is no use Bri is used
			await this.RampWithIntervalAsync(Group, true); // Returns true if finished or no lights with ramping without transition time

			if (this.LightGroups[Group].autoOffTimed.enabled) {
				//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
				await this.AutoOffTimedAsync(Group);
			}
		} else if (this.LightGroups[Group].rampOn.enabled && !this.LightGroups[Group].rampOn.switchOutletsLast) {
			//Anschalten mit Ramping und einfache Lampen zuerst

			this.writeLog(`[ ${funcName} ] Anschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			await this.DeviceSwitchAsync(Group, true); // Einfache Lampen
			await this.DeviceSwitchForRampingAsync(Group, true); //Restliche Lampen

			// Interval starten
			this.RampIntervalObject[Group] = this.setInterval(async () => {
				// Helligkeit erhöhen
				await this.SetBrightnessAsync(
					Group,
					Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
					"ramping",
				);

				LoopCount++;

				// Intervall stoppen
				if (LoopCount >= RampSteps) {
					if (this.LightGroups[Group].autoOffTimed.enabled) {
						//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

						await this.AutoOffTimedAsync(Group);
					}

					await this.clearRampIntervals(Group);
				}
			}, Math.round(this.LightGroups[Group].rampOn.time / RampSteps) * 1000);
		}
		return true;
	}

	/**
	 * TurnOffWithRamping
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async TurnOffWithRampingAsync(Group) {
		const funcName = "TurnOffWithRamping";
		if (!this.config?.RampSteps) {
			this.writeLog(
				`[ ${funcName} ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.config.RampSteps;
		let LoopCount = 0;
		//
		//******* Ausschalten mit Ramping */
		//
		if (this.LightGroups[Group].rampOff.enabled && this.LightGroups[Group].rampOff.switchOutletsLast) {
			////Ausschalten mit Ramping und einfache Lampen zuletzt

			this.writeLog(
				`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuletzt für Group="${Group}"`,
			);

			await this.clearRampIntervals(Group);

			// Interval starten
			this.RampIntervalObject[Group] = this.setInterval(async () => {
				// Helligkeit veringern
				await this.SetBrightnessAsync(
					Group,
					this.LightGroups[Group].bri -
						this.LightGroups[Group].bri / RampSteps -
						Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
					"ramping",
				);

				LoopCount++;

				// Intervall stoppen
				if (LoopCount >= RampSteps) {
					await this.clearRampIntervals(Group);
					await this.DeviceSwitchForRampingAsync(Group, false); //restliche Lampen
					await this.DeviceSwitchAsync(Group, false); // einfache Lampen
					this.LightGroups[Group].power = false;
					this.writeLog(`Result of TurnOffWithRamping: ${this.LightGroups[Group].power}`);
				}
			}, Math.round(this.LightGroups[Group].rampOff.time / RampSteps) * 1000);
		} else if (this.LightGroups[Group].rampOff.enabled && !this.LightGroups[Group].rampOff.switchOutletsLast) {
			////Ausschalten mit Ramping und einfache Lampen zuerst

			this.writeLog(`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			//Ausschalten von Lampen, welche keinen Brighness State haben

			await this.clearRampIntervals(Group);
			await this.DeviceSwitchAsync(Group, false); // einfache Lampen

			// Intervall starten
			this.RampIntervalObject[Group] = this.setInterval(async () => {
				await this.SetBrightnessAsync(
					Group,
					this.LightGroups[Group].bri -
						this.LightGroups[Group].bri / RampSteps -
						Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
					"ramping",
				);

				LoopCount++;
				// Intervall stoppen
				if (LoopCount >= RampSteps) {
					await this.DeviceSwitchForRampingAsync(Group, false); // restliche Lampen
					await this.clearRampIntervals(Group);
					this.LightGroups[Group].power = false;
					this.writeLog(`Result of TurnOffWithRamping: ${this.LightGroups[Group].power}`);
				}
			}, Math.round(this.LightGroups[Group].rampOff.time / RampSteps) * 1000);
		}
		return true;
	}

	/**
	 * GroupPowerCleaningLightOnOff
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async GroupPowerCleaningLightOnOffAsync(Group, OnOff) {
		const funcName = "GroupPowerCleaningLightOnOffAsync";
		this.writeLog(`[ ${funcName} ] Reaching GroupPowerCleaningLightOnOff for Group="${Group}, OnOff="${OnOff}"`);

		await this.clearAutoOffTimeouts(Group);

		if (OnOff) {
			if (this.LightGroups[Group].power) {
				await Promise.all([
					this.SetBrightnessAsync(Group, 100),
					this.SetCtAsync(Group, this.config.maxCt ?? 6700),
				]);
				this.LightGroups[Group].lastPower = true;
			} else {
				this.LightGroups[Group].power = true;
				this.LightGroups[Group].lastPower = false;
				await this.SimpleGroupPowerOnOffAsync(Group, true);
				await Promise.all([
					this.SetBrightnessAsync(Group, 100),
					this.SetCtAsync(Group, this.config.maxCt || 6700),
					this.setStateAsync(Group + ".power", true, true),
				]);
			}
		} else {
			const brightness = this.LightGroups[Group].adaptiveBri
				? await this.AdaptiveBriAsync(Group)
				: this.LightGroups[Group].bri;

			await Promise.all([
				this.SetBrightnessAsync(Group, brightness),
				this.SetCtAsync(Group, this.LightGroups[Group].ct),
			]);

			if (!this.LightGroups[Group].lastPower) {
				this.LightGroups[Group].power = false;
				await Promise.all([
					this.SimpleGroupPowerOnOffAsync(Group, false),
					this.setStateAsync(Group + ".power", false, true),
				]);
			}
		}

		await this.setStateAsync(Group + ".powerCleaningLight", OnOff, true);
	}

	/**
	 * AutoOnLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOnLuxAsync(Group) {
		if (
			!this.LightGroups[Group]?.autoOnLux ||
			!this.LightGroups[Group]?.autoOnLux?.enabled ||
			!this.LightGroups[Group]?.autoOnLux?.minLux ||
			!this.LightGroups[Group]?.autoOnLux?.dailyLock ||
			!this.LightGroups[Group]?.autoOnLux?.switchOnlyWhenPresence
		) {
			this.writeLog(
				`[ AutoOnLuxAsync ] Not able to auto on for Group: "${Group}". Please check your config! Aborted`,
			);
			return;
		}
		this.writeLog(
			`[ AutoOnLuxAsync ] Group="${Group} enabled="${this.LightGroups[Group].autoOnLux.enabled}", actuallux="${this.LightGroups[Group].actualLux}", minLux="${this.LightGroups[Group].autoOnLux.minLux}" LightGroups[Group].autoOnLux.dailyLock="${this.LightGroups[Group].autoOnLux.dailyLock}"`,
		);

		let tempBri = 0;
		let tempColor = "";

		if (this.LightGroups[Group].autoOnLux?.operator === "<") {
			if (
				this.LightGroups[Group].autoOnLux?.enabled &&
				!this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOnLux?.dailyLock &&
				this.LightGroups[Group].actualLux <= this.LightGroups[Group].autoOnLux?.minLux
			) {
				this.log.info(`[ AutoOnLuxAsync ] activated Group="${Group}"`);

				if (
					(this.LightGroups[Group].autoOnLux?.switchOnlyWhenPresence && this.ActualPresence) ||
					(this.LightGroups[Group].autoOnLux?.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOffAsync(Group, true);
					tempBri =
						this.LightGroups[Group].autoOnLux.bri !== 0
							? this.LightGroups[Group].autoOnLux.bri
							: (tempBri = this.LightGroups[Group].bri);
					await this.SetWhiteSubstituteColorAsync(Group);
					tempColor =
						this.LightGroups[Group].autoOnLux.color !== ""
							? this.LightGroups[Group].autoOnLux.color
							: (tempColor = this.LightGroups[Group].color);
					await this.PowerOnAftercareAsync(Group, tempBri, this.LightGroups[Group].ct, tempColor);
				}

				this.LightGroups[Group].autoOnLux.dailyLock = true;

				await this.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);
			} else if (
				this.LightGroups[Group].autoOnLux?.dailyLock &&
				this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOnLux?.minLux
			) {
				//DailyLock zurücksetzen

				this.LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (this.LightGroups[Group].autoOnLux?.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					this.LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					this.LightGroups[Group].autoOnLux.dailyLock = false;
					await this.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					this.writeLog(
						`[ AutoOnLuxAsync ] setting DailyLock to ${this.LightGroups[Group].autoOnLux.dailyLock}`,
						"info",
					);
				}
			}
		} else if (this.LightGroups[Group].autoOnLux.operator === ">") {
			if (
				this.LightGroups[Group].autoOnLux?.enabled &&
				!this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOnLux?.dailyLock &&
				this.LightGroups[Group].actualLux >= this.LightGroups[Group].autoOnLux?.minLux
			) {
				this.writeLog(`activated Group="${Group}"`, "info", "AutoOnLuxAsync");

				if (
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenPresence && this.ActualPresence) ||
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOffAsync(Group, true);
					tempBri =
						this.LightGroups[Group].autoOnLux.bri !== 0
							? this.LightGroups[Group].autoOnLux.bri
							: (tempBri = this.LightGroups[Group].bri);
					await this.SetWhiteSubstituteColorAsync(Group);
					tempColor =
						this.LightGroups[Group].autoOnLux.color !== ""
							? this.LightGroups[Group].autoOnLux.color
							: this.LightGroups[Group].color;
					await this.PowerOnAftercareAsync(Group, tempBri, this.LightGroups[Group].ct, tempColor);
				}

				this.LightGroups[Group].autoOnLux.dailyLock = true;
				await this.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);
			} else if (
				this.LightGroups[Group].autoOnLux.dailyLock &&
				this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOnLux.minLux
			) {
				//DailyLock zurücksetzen

				this.LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (this.LightGroups[Group].autoOnLux.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					this.LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					this.LightGroups[Group].autoOnLux.dailyLock = false;
					await this.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					this.writeLog(
						`setting DailyLock to ${this.LightGroups[Group].autoOnLux.dailyLock}`,
						"info",
						"AutoOnLuxAsync",
					);
				}
			}
		}
	}

	/**
	 * AutoOnMotion
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOnMotionAsync(Group) {
		if (
			!this.LightGroups[Group]?.autoOnMotion ||
			!this.LightGroups[Group]?.autoOnMotion?.enabled ||
			!this.LightGroups[Group]?.autoOnMotion?.minLux
		) {
			this.writeLog(
				`[ AutoOnMotion ] Not able to auto on for Group: "${Group}". Please check your config! Aborted`,
			);
			return;
		}

		this.writeLog(
			`[ AutoOnMotion ] Reaching for Group: "${Group}", enabled: ${this.LightGroups[Group]?.autoOnMotion?.enabled}, actualLux: ${this.LightGroups[Group]?.actualLux}, minLux: ${this.LightGroups[Group]?.autoOnMotion?.minLux}`,
		);

		let tempBri = 0;
		let tempColor = "";

		const { autoOnMotion, actualLux, isMotion, bri, color, ct } = this.LightGroups[Group] || {};

		if (autoOnMotion?.enabled && actualLux < autoOnMotion?.minLux && isMotion) {
			this.writeLog(`Motion for Group="${Group}" detected, switching on`, "info");
			await this.GroupPowerOnOffAsync(Group, true);

			tempBri = autoOnMotion?.bri !== 0 ? autoOnMotion?.bri : bri || tempBri;
			await this.SetWhiteSubstituteColorAsync(Group);

			tempColor = !autoOnMotion?.color ? autoOnMotion?.color : color || tempColor;
			await this.PowerOnAftercareAsync(Group, tempBri, ct, tempColor);
		}
	}

	/**
	 * AutoOnPresenceIncrease
	 */
	async AutoOnPresenceIncreaseAsync() {
		this.writeLog(`[ AutoOnPresenceIncreaseAsync ] Reaching`);
		let tempBri = 0;
		let tempColor = "";

		for (const Group in this.LightGroups) {
			if (Group === "All") continue;

			if (
				this.LightGroups[Group].autoOnPresenceIncrease.enabled &&
				this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOnPresenceIncrease.minLux &&
				!this.LightGroups[Group].power
			) {
				await this.GroupPowerOnOffAsync(Group, true);
				tempBri =
					this.LightGroups[Group].autoOnPresenceIncrease.bri !== 0
						? this.LightGroups[Group].autoOnPresenceIncrease.bri
						: this.LightGroups[Group].bri;
				await this.SetWhiteSubstituteColorAsync(Group);
				tempColor =
					this.LightGroups[Group].autoOnPresenceIncrease.color !== ""
						? this.LightGroups[Group].autoOnPresenceIncrease.color
						: (tempColor = this.LightGroups[Group].color);
				await this.PowerOnAftercareAsync(Group, tempBri, this.LightGroups[Group].ct, tempColor);
			}
		}
	}

	/**
	 * Blink
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async BlinkAsync(Group) {
		try {
			this.setStateAsync(Group + ".blink.enabled", true, true);

			let loopcount = 0;

			//Save actual power state
			await this.SetValueToObjectAsync(Group, "blink.actual_power", this.LightGroups[Group].power);

			if (!this.LightGroups[Group].power) {
				//Wenn Gruppe aus, anschalten und ggfs. Helligkeit und Farbe setzen

				this.writeLog(`[ Blink ] on ${loopcount}`, "info");

				for (const Light of this.LightGroups[Group].lights) {
					if (!Light?.power?.oid && !Light?.bri?.oid) {
						this.writeLog(
							`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
							"warn",
						);
					} else if (Light?.bri?.useBri && Light?.bri?.oid) {
						await this.setForeignStateAsync(Light.bri.oid, this.LightGroups[Group].blink.bri, false);
						this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
					} else if (Light?.power?.oid) {
						await this.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
						this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
						if (Light?.bri?.oid && this.LightGroups[Group].blink.bri !== 0)
							await this.setDeviceBriAsync(Light, this.LightGroups[Group].blink.bri);
					}
				}

				this.LightGroups[Group].power = true;
				await this.setStateAsync(Group + ".power", true, true);

				await this.SetWhiteSubstituteColorAsync(Group);

				if (this.LightGroups[Group].blink.color != "")
					await this.SetColorAsync(Group, this.LightGroups[Group].blink.color);

				loopcount++;
			}

			await this.clearBlinkIntervals(Group);

			this.BlinkIntervalObj[Group] = setInterval(async () => {
				loopcount++;

				this.writeLog(`[ Blink ] Is Infinite: ${this.LightGroups[Group].blink.infinite}`);
				this.writeLog(`[ Blink ] Stop: ${this.LightGroups[Group].blink.stop || false}`);

				if (
					(loopcount <= this.LightGroups[Group].blink.blinks * 2 || this.LightGroups[Group].blink.infinite) &&
					!this.LightGroups[Group].blink.stop
				) {
					if (this.LightGroups[Group].power) {
						this.writeLog(`[ Blink ] off ${loopcount}`, "info");

						for (const Light of this.LightGroups[Group].lights) {
							if (!Light?.power?.oid && !Light?.bri?.oid) {
								this.writeLog(
									`[ Blink ] Can't switch off. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
									"warn",
								);
							} else if (Light?.bri?.useBri && Light?.bri?.oid) {
								await this.setForeignStateAsync(Light.bri.oid, 0, false);
								this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: off`);
							} else if (Light?.power?.oid) {
								await this.setForeignStateAsync(Light.power.oid, Light.power.offVal, false);
								this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
							}
						}

						await this.SetWhiteSubstituteColorAsync(Group);

						if (this.LightGroups[Group].blink.color != "")
							await this.SetColorAsync(Group, this.LightGroups[Group].blink.color);

						this.LightGroups[Group].power = false;
						this.setStateAsync(Group + ".power", false, true);
						//this.SetLightState();
					} else {
						this.writeLog(`[ Blink ] => on ${loopcount}`, "info");

						for (const Light of this.LightGroups[Group].lights) {
							if (!Light?.power?.oid && !Light?.bri?.oid) {
								this.writeLog(
									`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
									"warn",
								);
							} else if (Light?.bri?.useBri && Light?.bri?.oid) {
								await this.setForeignStateAsync(
									Light.bri.oid,
									this.LightGroups[Group].blink.bri,
									false,
								);
								this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
							} else if (Light?.power?.oid) {
								await this.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
								this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
							}
						}

						this.LightGroups[Group].power = true;
						this.setStateAsync(Group + ".power", true, true);
						//this.SetLightState();
					}
				} else {
					await this.clearBlinkIntervals(Group);
					this.setStateAsync(Group + ".blink.enabled", false, true);
					if (this.LightGroups[Group].blink.infinite || this.LightGroups[Group].blink.actual_power) {
						await this.setStateAsync(Group + ".power", this.LightGroups[Group].blink.actual_power, false);
						await this.SetColorAsync(Group, this.LightGroups[Group].color);
					}
				}
			}, this.LightGroups[Group].blink.frequency * 1000);
		} catch (error) {
			this.writeLog(error, "error", "Blink");
		}
	}

	/**
	 * AutoOffLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOffLuxAsync(Group) {
		//Handling für AutoOffLux

		this.writeLog(`[ AutoOffLux ] Reaching for Group="${Group}"`);

		if (
			this.LightGroups[Group].autoOffLux?.operator === "<" &&
			this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOffLux?.minLux &&
			this.LightGroups[Group].autoOffLux?.enabled &&
			this.LightGroups[Group].power &&
			!this.LightGroups[Group].autoOffLux?.dailyLock
		) {
			await this.GroupPowerOnOffAsync(Group, false);
			this.LightGroups[Group].autoOffLux.dailyLock = true;
			await this.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
		} else if (
			this.LightGroups[Group].autoOffLux?.operator === ">" &&
			this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOffLux?.minLux &&
			this.LightGroups[Group].autoOffLux?.enabled &&
			this.LightGroups[Group].power &&
			!this.LightGroups[Group].autoOffLux?.dailyLock
		) {
			await this.GroupPowerOnOffAsync(Group, false);
			this.LightGroups[Group].autoOffLux.dailyLock = true;
			await this.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
		}

		if (this.LightGroups[Group].autoOffLux?.operator === "<") {
			//DailyLock resetten

			if (
				this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOffLux?.minLux &&
				this.LightGroups[Group].autoOffLux?.dailyLock
			) {
				this.LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (this.LightGroups[Group].autoOffLux?.dailyLockCounter >= 5) {
					this.LightGroups[Group].autoOffLux.dailyLock = false;
					await this.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					this.LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		} else if (this.LightGroups[Group].autoOffLux?.operator === ">") {
			if (
				this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOffLux?.minLux &&
				this.LightGroups[Group].autoOffLux.dailyLock
			) {
				this.LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (this.LightGroups[Group].autoOffLux?.dailyLockCounter >= 5) {
					this.LightGroups[Group].autoOffLux.dailyLock = false;
					await this.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
					this.LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		}
	}

	/**
	 * AutoOffTimed
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOffTimedAsync(Group) {
		this.writeLog(
			`[ AutoOffTimed ] Reaching for Group="${Group}" set time="${this.LightGroups[Group].autoOffTimed.autoOffTime}" LightGroups[${Group}].isMotion="${this.LightGroups[Group].isMotion}" LightGroups[${Group}].autoOffTimed.noAutoOffWhenMotion="${this.LightGroups[Group].autoOffTimed.noAutoOffWhenMotion}"`,
		);

		await this.clearAutoOffTimeouts(Group);

		if (this.LightGroups[Group].autoOffTimed.enabled) {
			this.writeLog(`[ AutoOffTimed ] Start Timeout`);

			this.AutoOffTimeoutObject[Group] = this.setTimeout(async () => {
				// Interval starten
				if (this.LightGroups[Group].autoOffTimed.noAutoOffWhenMotion && this.LightGroups[Group].isMotion) {
					//Wenn noAutoOffWhenmotion aktiv und Bewegung erkannt
					this.writeLog(
						`[ AutoOffTimed ] Motion already detected, restarting Timeout for Group="${Group}" set time="${this.LightGroups[Group].autoOffTimed.autoOffTime}"`,
					);
					this.writeLog(`[ AutoOffTimed ] Timer: ${JSON.stringify(this.AutoOffTimeoutObject[Group])}`);
					await this.AutoOffTimedAsync(Group);
				} else {
					this.writeLog(
						`[ AutoOffTimed ] Group="${Group}" timed out, switching off. Motion="${this.LightGroups[Group].isMotion}"`,
					);
					await this.GroupPowerOnOffAsync(Group, false);
				}
			}, Math.round(this.LightGroups[Group].autoOffTimed.autoOffTime) * 1000);
		}
	}

	/**
	 * SetMasterPower
	 * @param NewVal New Value of state
	 */
	async SetMasterPowerAsync(NewVal) {
		const funcName = "SetMasterPower";

		this.writeLog(`[ ${funcName} ] Reaching SetMasterPower`);

		const promises = Object.keys(this.LightGroups)
			.filter((Group) => Group !== "All")
			.map((Group) => {
				this.writeLog(`[ ${funcName} ] Switching Group="${Group}" to ${NewVal}`);
				return this.setStateAsync(Group + ".power", NewVal, false);
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(`Not able to set master power. Error: ${error}`, "error", funcName);
			return;
		});
	}
	// *********************************************
	// *                                           *
	// *            LIGHT HANDLING                 *
	// *                                           *
	// *********************************************

	/**
	 * AdaptiveBri
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @returns {Promise<number>} Brightness value
	 */
	async AdaptiveBriAsync(Group) {
		this.writeLog(
			`[ AdaptiveBri ] Reaching for Group="${Group}" actual Lux="${this.LightGroups[Group].actualLux}" generic lux="${this.ActualGenericLux}`,
		);

		let TempBri = 0;
		const minBri = typeof this.config.minBri === "string" ? parseInt(this.config.minBri) : this.config.minBri;

		if (this.LightGroups[Group].adaptiveBri) {
			if (this.LightGroups[Group].actualLux === 0) {
				TempBri = minBri;
			} else if (this.LightGroups[Group].actualLux >= 10000) {
				TempBri = 100;
			} else if (this.LightGroups[Group].actualLux > 0 && this.LightGroups[Group].actualLux < 10000) {
				TempBri = this.LightGroups[Group].actualLux / 100;

				if (TempBri < this.config.minBri) TempBri = minBri;
			}
		}
		return Math.round(TempBri);
	}

	/**
	 * SetBrightness
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} Brightness Value 0 to 100
	 * @param {string} [caller="default"] - Quelle des Funktionsaufrufs. Standardmäßig "default"
	 */
	async SetBrightnessAsync(Group, Brightness, caller = "default") {
		this.writeLog(
			`[ SetBrightness ] Reaching for Group="${Group}", Brightness="${Brightness}, PowerState="${this.LightGroups[Group].power}"`,
		);
		if (!this.LightGroups[Group]?.lights?.length) {
			this.writeLog(
				`[ SetBrightness ] Not able to set Brighness for Group = "${Group}". No lights are defined or group not defined!!`,
				"warn",
			);
			return;
		}

		//Set Brightness only if Group Power on
		if (this.LightGroups[Group].power) {
			const promises = this.LightGroups[Group].lights
				.filter((Light) => Light?.bri?.oid)
				.map((Light) => this.setDeviceBriAsync(Light, Brightness));

			await Promise.all(promises).catch((error) => {
				this.writeLog(error, "error", "SetBrightnessAsync");
				return;
			});
		}

		if (caller === "default") await this.setStateAsync(Group + "." + "bri", Brightness, true);
		return true;
	}

	/**
	 * Sets the brightness of a device based on the given `Brightness` parameter and the `minVal` and `maxVal` values from the `Light` object.
	 * @param {object} Light - The Light object containing the device information, including the `minVal` and `maxVal` values for the brightness.
	 * @param {number | undefined} brightness - The brightness value to be set on the device.
	 * @returns {Promise<boolean>} - Returns a Promise that resolves to `true` if the brightness was successfully set, or `false` if there was an error.
	 */
	async setDeviceBriAsync(Light, brightness) {
		const { bri } = Light ?? {};
		if (!bri?.oid) {
			return false;
		}
		const log = !bri?.useBri
			? `[ setDeviceBri ] Switching with Power State is activated. Min. Brightness is defined with 2%. Actual Brightness = "${brightness}"`
			: `[ setDeviceBri ] Switching with Brightness is activated. No min. Brightness needed. Actual Brightness = "${brightness}"`;
		this.writeLog(log);

		const minBrightness = bri?.useBri ? 0 : 2;
		brightness = Math.round(Math.min(Math.max(brightness || 0, minBrightness), 100));

		const minVal = bri?.minVal ?? 0;
		const maxVal = bri?.maxVal ?? 100;
		const defaultBri = bri?.defaultBri ?? 100;

		const value = Math.round((brightness / 100) * (maxVal - minVal) + minVal);

		await this.setForeignStateAsync(Light.bri.oid, Math.round((value / maxVal) * defaultBri), false).catch(
			(error) => {
				this.writeLog(error, "error", "setDeviceBriAsync");
				return;
			},
		);

		return true;
	}

	/**
	 * setCt
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} ct
	 */
	async SetCtAsync(Group, ct = this.LightGroups[Group].ct) {
		if (!this.LightGroups[Group].lights?.length) {
			this.writeLog(
				`[ SetCt ] Not able to set Color-Temperature for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const ctValue = ct ?? this.LightGroups[Group].ct;

		this.writeLog(`[ SetCt ] Reaching for Group="${Group}" Ct="${ctValue}"`);

		await Promise.all(
			this.LightGroups[Group].lights.map(async (Light) => {
				const { ct } = Light ?? {};
				if ((this.LightGroups[Group].power || ct?.sendCt) && ct?.oid) {
					const oid = ct?.oid;
					const outMinVal = ct?.minVal || 0;
					const outMaxVal = ct?.maxVal || 100;
					const minKelvin = ct?.minKelvin || 2700;
					const maxKelvin = ct?.maxKelvin || 6500;
					const ctConversion = ct?.ctConversion ?? "default";
					const value = await helper.KelvinToRange(
						this,
						outMinVal,
						outMaxVal,
						minKelvin,
						maxKelvin,
						ctValue,
						ctConversion,
					);
					if (value < 0) {
						this.writeLog(
							`[ SetCt ] Not able to set Color-Temperature for Light="${oid}" in Group ="${Group}". No conversion defined!!`,
							"warn",
						);
						return;
					} else if (value >= 0) {
						await this.setForeignStateAsync(oid, value, false);
					}
				}
			}),
		).catch((error) => {
			this.writeLog(error, "error", "SetCtAsync");
			return;
		});

		await this.setStateAsync(Group + ".ct", ctValue, true);

		return true;
	}

	/**
	 * AdapticeCt
	 */
	async AdaptiveCtAsync() {
		const now = new Date();
		const ActualTime = now.getTime();

		const minCt = this.config.minCt ?? 2000;
		const maxCt = this.config.maxCt ?? 6700;
		const CtRange = maxCt - minCt;

		this.writeLog(`[ AdaptiveCtAsync ] minCT="${minCt}", maxCt="${maxCt}", CtRange="${CtRange}"`);

		let adaptiveCtLinear = 0;
		let adaptiveCtSolar = 0;
		let adaptiveCtSolarInterpolated = 0;
		let adaptiveCtTimed = 0;
		let adaptiveCtTimedInterpolated = 0;
		let sunset = 0;
		let sunrise = 0;
		let solarNoon = 0;

		const [sunsetDate, sunriseDate, solarNoonDate] = await Promise.all([
			getAstroDate(this, "sunset", undefined),
			getAstroDate(this, "sunrise", undefined),
			getAstroDate(this, "solarNoon", undefined),
		]);

		this.writeLog(
			`[ AdaptiveCtAsync // getAstroDate] sunsetDate="${sunsetDate}", sunriseDate="${sunriseDate}", solarNoonDate="${solarNoonDate}"`,
		);

		if (sunsetDate instanceof Date && sunriseDate instanceof Date && solarNoonDate instanceof Date) {
			sunset = sunsetDate.getTime(); //Sonnenuntergang
			sunrise = sunriseDate.getTime(); //Sonnenaufgang
			solarNoon = solarNoonDate.getTime(); //Höchster Sonnenstand (Mittag)
		} else {
			this.writeLog(`[ AdaptiveCtAsync ] sunsetDate, sunriseDate or solarNoonDate are no Date Objects"`, "warn");
			return;
		}

		this.writeLog(
			`[ AdaptiveCtAsync ] minCT="${minCt}", maxCt="${maxCt}", sunset="${sunset}", sunrise="${sunrise}", solarNoon="${solarNoon}"`,
		);

		let morningTime = 0;

		const sunMinutesDay = (sunset - sunrise) / 1000 / 60;
		const RangePerMinute = CtRange / sunMinutesDay;

		const sunpos = SunCalc.getPosition(now, this.lat, this.lng);
		const sunposNoon = SunCalc.getPosition(solarNoon, this.lat, this.lng);

		if (compareTime(this, sunrise, solarNoon, "between", ActualTime)) {
			//   log("Aufsteigend")
			adaptiveCtLinear = Math.round(minCt + ((ActualTime - sunrise) / 1000 / 60) * RangePerMinute * 2); // Linear = ansteigende Rampe von Sonnenaufgang bis Sonnenmittag, danach abfallend bis Sonnenuntergang
		} else if (compareTime(this, solarNoon, sunset, "between", ActualTime)) {
			//   log("Absteigend")
			adaptiveCtLinear = Math.round(maxCt - ((ActualTime - solarNoon) / 1000 / 60) * RangePerMinute * 2);
		}

		if (compareTime(this, sunrise, sunset, "between", ActualTime)) {
			adaptiveCtSolar = Math.round(minCt + sunMinutesDay * RangePerMinute * sunpos.altitude); // Solar = Sinusrampe entsprechend direkter Elevation, max Ct differiert nach Jahreszeiten
			adaptiveCtSolarInterpolated = Math.round(
				minCt + sunMinutesDay * RangePerMinute * sunpos.altitude * (1 / sunposNoon.altitude),
			); // SolarInterpolated = Wie Solar, jedoch wird der Wert so hochgerechnet dass immer zum Sonnenmittag maxCt gesetzt wird, unabhängig der Jahreszeit
		}

		this.writeLog(
			`[ AdaptiveCtAsync ] adaptiveCtLinear="${adaptiveCtLinear}" adaptiveCtSolar="${adaptiveCtSolar}"`,
		);

		for (const Group in this.LightGroups) {
			if (Group === "All") continue;

			switch (this.LightGroups[Group].adaptiveCtMode) {
				case "linear":
					if (
						this.LightGroups[Group].adaptiveCt?.enabled &&
						this.LightGroups[Group].ct !== adaptiveCtLinear
					) {
						await this.setStateAsync(Group + ".ct", adaptiveCtLinear, false);
					}
					break;

				case "solar":
					if (this.LightGroups[Group].adaptiveCt?.enabled && this.LightGroups[Group].ct !== adaptiveCtSolar) {
						await this.setStateAsync(Group + ".ct", adaptiveCtSolar, false);
					}
					break;

				case "solarInterpolated":
					if (
						this.LightGroups[Group].adaptiveCt?.enabled &&
						this.LightGroups[Group].ct !== adaptiveCtSolarInterpolated
					) {
						await this.setStateAsync(Group + ".ct", adaptiveCtSolarInterpolated, false);
					}
					break;
				case "timed":
					if (this.LightGroups[Group].AdaptiveCt?.enabled && this.LightGroups[Group].ct !== adaptiveCtTimed) {
						morningTime = getDateObject(this.LightGroups[Group].adaptiveCt?.adaptiveCtTime).getTime();
						if (ActualTime >= morningTime && ActualTime <= sunset) {
							adaptiveCtTimed = Math.round(
								maxCt + ((minCt - maxCt) * (ActualTime - morningTime)) / (sunset - morningTime),
							);
						} else {
							adaptiveCtTimed = minCt;
						}

						this.writeLog(
							`[ AdaptiveCtAsync // timed ] morningTime="${this.LightGroups[Group].adaptiveCt?.adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimed}"`,
						);

						await this.setStateAsync(Group + ".ct", adaptiveCtTimed, false);
					}
					break;
				case "timedInterpolated":
					if (
						this.LightGroups[Group].adaptiveCt?.enabled &&
						this.LightGroups[Group].ct !== adaptiveCtTimedInterpolated
					) {
						morningTime = getDateObject(this.LightGroups[Group].adaptiveCt?.adaptiveCtTime).getTime();

						if (ActualTime >= morningTime && ActualTime <= sunset) {
							const base = 2;
							const timeFraction = (ActualTime - morningTime) / (sunset - morningTime);
							const exponentialValue = Math.pow(base, timeFraction);
							adaptiveCtTimedInterpolated = Math.round(
								helper.rangeMapping(exponentialValue, 1, base, maxCt, minCt),
							);
						} else {
							adaptiveCtTimedInterpolated = minCt;
						}

						this.writeLog(
							`[ AdaptiveCtAsync // timedInterpolated ] morningTime="${this.LightGroups[Group].adaptiveCt?.adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimedInterpolated}"`,
						);

						await this.setStateAsync(Group + ".ct", adaptiveCtTimedInterpolated, false);
					}
					break;
			}
		}

		//Timeout 60s to restart function
		if (this.TickerIntervall) clearTimeout(this.TickerIntervall), (this.TickerIntervall = null);
		this.TickerIntervall = setTimeout(() => {
			this.AdaptiveCtAsync();
		}, 60000);
	}

	/**
	 * SetWhiteSubstituteColor
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async SetWhiteSubstituteColorAsync(Group) {
		if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetWhiteSubstituteColorAsync ] Not able to set white substitute color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const minCt = this.config.minCt ?? 2000;
		const maxCt = this.config.maxCt ?? 6700;

		this.writeLog(
			`[ SetWhiteSubstituteColorAsync ] Reaching for Group="${Group}" = "${this.LightGroups[Group].description}" LightGroups[Group].power="${this.LightGroups[Group].power}" LightGroups[Group].color="${this.LightGroups[Group].color}`,
			"info",
		);

		//Nur ausführen bei anschalten und Farbe weiß

		const promisesWarmWhiteDayLight = this.LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light?.color?.warmWhiteColor &&
					Light?.color?.dayLightColor &&
					Light.color?.setCtwithColor &&
					!Light.color?.type?.hue &&
					!Light.sat?.oid &&
					this.LightGroups[Group].color.toUpperCase() == "#FFFFFF" &&
					(this.LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map(async (Light) => {
				const colorValue =
					this.LightGroups[Group].ct < (maxCt - minCt) / 4 + minCt
						? Light.color.warmWhiteColor
						: Light.color.dayLightColor;
				await this.setForeignStateAsync(Light.color.oid, colorValue, false);
			});

		const promisesKelvinWithHUE = this.LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.hue &&
					Light.bri?.oid &&
					Light.sat?.oid &&
					(this.LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map(async (Light) => {
				const colorValue = converters.ConvertKelvinToHue(this.LightGroups[Group].ct);
				await Promise.all([
					this.setForeignStateAsync(Light.color.oid, colorValue.hue, false),
					this.setForeignStateAsync(Light.sat.oid, colorValue.saturation, false),
					this.setForeignStateAsync(Light.bri.oid, colorValue.brightness, false),
				]);
			});

		const promisesKelvinWithRGB = this.LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.rgb &&
					(this.LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map(async (Light) => {
				const colorValue = converters.convertKelvinToRGB(this.LightGroups[Group].ct);
				await this.setForeignStateAsync(Light.color.oid, { val: JSON.stringify(colorValue), ack: false });
			});

		const promisesKelvinWithXY = this.LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.xy &&
					(this.LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map(async (Light) => {
				const rgb = converters.convertKelvinToRGB(this.LightGroups[Group].ct);
				const colorValue = converters.ConvertRgbToXy(rgb);
				await this.setForeignStateAsync(Light.color.oid, { val: JSON.stringify(colorValue), ack: false });
			});

		await Promise.all([
			promisesWarmWhiteDayLight,
			promisesKelvinWithHUE,
			promisesKelvinWithRGB,
			promisesKelvinWithXY,
		]).catch((error) => {
			this.writeLog(error, "error", "SetWhiteSubstituteColorAsync");
		});
	}

	/**
	 * SetColorMode
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async SetColorModeAsync(Group) {
		if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetColorModeAsync ] Not able to set color mode for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		this.writeLog(`[ SetColorModeAsync ] Reaching for Group="${Group}"`, "info");

		const promises = this.LightGroups[Group].lights
			.filter(
				(Light) =>
					Light.modeswitch &&
					(this.LightGroups[Group].power || Light?.modeswitch?.sendModeswitch) &&
					Light?.modeswitch?.oid,
			) // Prüfen, ob der Datenpunkt vorhanden ist und die Bedingungen erfüllt sind
			.map(async (Light) => {
				if (this.LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
					// bei Farbe weiss
					await Promise.all([
						this.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.whiteModeVal, false),
						this.writeLog(`[ SetColorModeAsync ] Device="${Light.modeswitch.oid}" to whiteMode`, "info"),
					]);
				} else {
					// bei allen anderen Farben
					await Promise.all([
						this.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.colorModeVal, false),
						this.writeLog(`[ SetColorModeAsync ] Device="${Light.modeswitch.oid}" to colorMode`, "info"),
					]);
				}
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(error, "error", "SetColorModeAsync");
		});

		return true;
	}

	/**
	 * SetColor
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {any} Color
	 */
	async SetColorAsync(Group, Color) {
		if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetColorAsync ] Not able to set color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(
			`[ SetColorAsync ] Reaching for Group="${Group}" power="${this.LightGroups[Group].power}" Color="${Color}"`,
			"info",
		);

		const promises = this.LightGroups[Group].lights
			.filter((Light) => Light.color && (this.LightGroups[Group].power || Light?.color?.sendColor))
			.map(async (Light) => {
				if (Light?.color?.oid) {
					// Prüfen ob Datenpunkt für Color vorhanden
					switch (Light.color.colorType) {
						case "hex":
							await this.setForeignStateAsync(Light.color.oid, Color, false);
							break;
						case "rgb": {
							const rgbTemp = converters.ConvertHexToRgb(Color);
							await this.setForeignStateAsync(Light.color.oid, {
								val: JSON.stringify(rgbTemp),
								ack: false,
							});
							break;
						}
						case "xy": {
							const rgbTemp = converters.ConvertHexToRgb(Color);
							const XyTemp = converters.ConvertRgbToXy(rgbTemp);
							await this.setForeignStateAsync(Light.color.oid, {
								val: JSON.stringify(XyTemp),
								ack: false,
							});
							break;
						}
						case "hue": {
							if (Light.bri?.oid && Light.sat?.oid) {
								const colorValue = converters.ConvertHexToHue(Color);
								await Promise.all([
									this.setForeignStateAsync(Light.color.oid, colorValue.hue, false),
									this.setForeignStateAsync(Light.sat.oid, colorValue.saturation, false),
									this.setForeignStateAsync(Light.bri.oid, colorValue.brightness, false),
								]);
							} else {
								await this.writeLog(
									`[ SetColorAsync ] Set color with HUE is not possible, because brightness or saturation state is not defined!`,
									"warn",
								);
							}
							break;
						}
						default:
							await this.writeLog(
								`[ SetColorAsync ] Unknown colorType = "${Light.color.colorType}" in Group="${Group}", please specify!`,
								"warn",
							);
					}
				}
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(error, "error", "SetColorAsync");
		});

		await this.setStateAsync(Group + ".color", this.LightGroups[Group].color, true);
		return true;
	}

	/**
	 * SetTtAsync
	 * @description Set transmission time to lights
	 * @async
	 * @function
	 * @param {object} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} RampTime Information about the RampTime in milliseconds
	 * @param {string} prop rampUp, rampDown or standard
	 */
	async SetTtAsync(Group, RampTime, prop) {
		if (!this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetTtAsync ] Not able to set transition time for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(`[ SetTtAsync ] Reaching for Group="${Group}", TransitionTime="${RampTime}ms"`);

		const promises = this.LightGroups[Group].lights
			.filter((Light) => Light.tt?.oid)
			.map(async (Light) => {
				const tt = convertTime(Light.tt.unit, RampTime);
				await Promise.all([
					this.setForeignStateAsync(Light.tt.oid, { val: tt, ack: false }),
					this.writeLog(`[ SetTt ] Set ${Light.description} (${Light.tt.oid}) to: ${tt}${Light.tt.unit}`),
				]);
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(error, "error", "SetTtAsync");
		});

		await this.setStateAsync(Group + "." + prop, RampTime, true);
		return true;
	}

	/**
	 * PowerOnAftercare
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} bri Brighness 0 - 100 %
	 * @param {number} ct Color-Temperatur Kelvin
	 * @param {string} color Color HEX value
	 */
	async PowerOnAftercareAsync(
		Group,
		bri = this.LightGroups[Group].bri,
		ct = this.LightGroups[Group].ct,
		color = this.LightGroups[Group].color,
	) {
		this.writeLog(
			`[ PowerOnAftercareAsync ] Reaching for Group="${Group}" bri="${bri}" ct="${ct}" color="${color}"`,
			"info",
		);

		if (this.LightGroups[Group].power) {
			//Nur bei anschalten ausführen

			if (!this.LightGroups[Group].rampOn.enabled) {
				//Wenn kein RampOn Helligkeit direkt setzen

				if (this.LightGroups[Group].adaptiveBri) {
					//Bei aktiviertem AdaptiveBri
					await this.SetBrightnessAsync(Group, await this.AdaptiveBriAsync(Group));
				} else {
					this.writeLog(`[ PowerOnAfterCare ] Now setting bri to ${bri}% for Group="${Group}"`, "info");
					await this.SetBrightnessAsync(Group, bri);
				}
			}

			await this.SetColorAsync(Group, color); //Nach anschalten Color setzen

			if (color == "#FFFFFF") await this.SetWhiteSubstituteColorAsync(Group);

			await this.SetColorModeAsync(Group); //Nach anschalten Colormode setzen

			if (color == "#FFFFFF") await this.SetCtAsync(Group, ct); //Nach anschalten Ct setzen
		}
	}
	// *********************************************
	// *                                           *
	// *               TIMERS                      *
	// *                                           *
	// *********************************************

	async clearRampIntervals(Group) {
		if (Group == null) {
			for (const groupKey in this.LightGroups) {
				if (groupKey === "All") continue;

				const intervalObject = this.RampIntervalObject[groupKey];
				if (typeof intervalObject === "object") {
					this.writeLog(`[ clearRampInterval ] Interval for group="${groupKey}" deleted.`);
					this.clearInterval(intervalObject);
				}
			}
		} else {
			const intervalObject = this.RampIntervalObject[Group];
			if (typeof intervalObject === "object") {
				this.writeLog(`[ clearRampInterval ] Interval for group="${Group}" deleted.`);
				this.clearInterval(intervalObject);
			}
		}
	}

	async clearAutoOffTimeouts(Group) {
		if (Group === null) {
			for (const groupKey in this.LightGroups) {
				if (groupKey === "All") continue;

				const timeoutObject = this.AutoOffTimeoutObject[groupKey];
				const noticeTimeoutObject = this.AutoOffNoticeTimeoutObject[groupKey];

				if (typeof timeoutObject === "object") {
					this.writeLog(`[ clearAutoOffTimeout ] => Timeout for group="${groupKey}" deleted.`);
					this.clearTimeout(timeoutObject);
				}

				if (typeof noticeTimeoutObject === "object") {
					this.writeLog(`[ clearAutoOffTimeout ] NoticeTimeout for group="${groupKey}" deleted.`);
					this.clearTimeout(noticeTimeoutObject);
				}
			}
		} else {
			const timeoutObject = this.AutoOffTimeoutObject[Group];
			const noticeTimeoutObject = this.AutoOffNoticeTimeoutObject[Group];

			if (typeof timeoutObject === "object") {
				this.writeLog(`[ clearAutoOffTimeout ] Timeout for group="${Group}" deleted.`);
				this.clearTimeout(timeoutObject);
			}

			if (typeof noticeTimeoutObject === "object") {
				this.writeLog(`[ clearAutoOffTimeout ] NoticeTimeout for group="${Group}" deleted.`);
				this.clearTimeout(noticeTimeoutObject);
			}
		}
	}

	async clearBlinkIntervals(Group) {
		if (Group === null) {
			for (const groupKey in this.LightGroups) {
				if (groupKey === "All") continue;

				const intervalObject = this.BlinkIntervalObj[groupKey];

				if (typeof intervalObject === "object") {
					this.writeLog(`[ clearBlinkIntervals ] Interval for group="${groupKey}" deleted.`);
					this.clearInterval(intervalObject);
				}
			}
		} else {
			const intervalObject = this.BlinkIntervalObj[Group];

			if (typeof intervalObject === "object") {
				this.writeLog(`[ clearBlinkIntervals ] Interval for group="${Group}" deleted.`);
				this.clearInterval(intervalObject);
			}
		}
	}

	async clearTransitionTimeout(Group) {
		if (Group === null) {
			for (const groupKey in this.LightGroups) {
				if (groupKey === "All") continue;

				const timeoutObject = this.TransitionTimeoutObject[groupKey];

				if (typeof timeoutObject === "object") {
					this.writeLog(`[ clearTransitionTimeout ] Timeout for group="${groupKey}" deleted.`);
					this.clearInterval(timeoutObject);
				}
			}
		} else {
			const timeoutObject = this.TransitionTimeoutObject[Group];

			if (typeof timeoutObject === "object") {
				this.writeLog(`[ clearTransitionTimeout ] Timeout for group="${Group}" deleted.`);
				this.clearInterval(timeoutObject);
			}
		}
	}

	// *********************************************
	// *                                           *
	// *        		INIT                       *
	// *                                           *
	// *********************************************

	/**
	 * State create, extend objects and subscribe states
	 */
	async InitAsync() {
		this.writeLog(`Init is starting...`, "info");
		this.isInit = true;
		if (this.DevMode) await this.TestStatesCreateAsync();
		await this.GlobalLuxHandlingAsync();
		await this.GlobalPresenceHandlingAsync();
		await this.StatesCreateAsync();

		//Check internal memory and objects of instance
		const objMemory = await this.getAdapterObjectsAsync();
		if (!objMemory) {
			this.writeLog(`Cannot read objects from instance! Init Aborted!`, "warn");
			return false;
		} else {
			const objInstance = helper.createNestedObject(this.namespace, objMemory);
			//this.writeLog(`objA: ${JSON.stringify(nestedObject)}`);
			const result = helper.compareAndFormatObjects(objInstance, this.LightGroups);
			if (result.length > 0) {
				this.writeLog(
					`Internal memory and objects of instance not are the same. Please restart adapter or contact developer.`,
					"warn",
				);
				this.writeLog(`${JSON.stringify(result)}`, "warn");
				return false;
			}
		}

		const latlng = await this.GetSystemDataAsync();
		if (latlng) await this.AdaptiveCtAsync();
		await this.InitCustomStatesAsync();
		await this.SetLightStateAsync();

		this.writeLog(`Init finished.`, "info");
		this.isInit = false;
		return true;
	}

	/**
	 * Create LightGroups Object
	 * @description Creates Object LightGroups from system.config array
	 */
	async CreateLightGroupsObject() {
		const { config } = this;
		const { LightGroups } = config;

		if (LightGroups && LightGroups.length) {
			const regex = /^[a-zA-Z0-9_-]*$/; // Regulärer Ausdruck zur Überprüfung von erlaubten Zeichen
			LightGroups.forEach(({ Group, GroupLuxSensor }) => {
				if (!regex.test(Group)) {
					// Überprüfen, ob "Group" nur erlaubte Zeichen enthält
					this.writeLog(
						`[ CreateLightGroupsObject ] Group "${Group}" contains invalid characters. Please update the group name in instance setting. Skipping...`,
						"warn",
					);
					return; // Überspringen des Loops, wenn "Group" ungültige Zeichen enthält
				}
				this.LightGroups[Group] = {
					description: Group,
					LuxSensor: GroupLuxSensor,
					lights: [],
					sensors: [],
				};
			});

			// Füge den Schlüssel "All" hinzu
			this.LightGroups.All = {
				description: "All",
				power: false,
				anyOn: false,
			};

			this.writeLog(`[ CreateLightGroupsObject ] LightGroups: ${JSON.stringify(this.LightGroups)}`);
		} else {
			this.writeLog(`[ CreateLightGroupsObject ] No LightGroups defined in instance settings!`, "warn");
		}
	}

	/**
	 * GlobalLuxHandlingAsync
	 * @description If a global lux sensor has been defined, its value is written to the global variable and the state is subscribed.
	 */
	async GlobalLuxHandlingAsync() {
		try {
			const { config } = this;
			const { GlobalLuxSensor } = config;
			this.ActualGenericLux = 0;

			if (!GlobalLuxSensor) {
				return;
			}

			const actualGenericLux = await this.getForeignStateAsync(GlobalLuxSensor);
			const _actualGenericLux = await helper.checkObjectNumber(actualGenericLux);

			if (_actualGenericLux === null) {
				this.log.warn(
					`[ GlobalLuxHandlingAsync ] state value of id="${GlobalLuxSensor}" is empty, null, undefined, or not a valid number!`,
				);
				return;
			}

			this.ActualGenericLux = _actualGenericLux;
			await this.subscribeForeignStatesAsync(GlobalLuxSensor);
			this.LuxSensors.push(GlobalLuxSensor);
		} catch (error) {
			this.writeLog(error, "error", "GlobalLuxHandlingAsync");
		}
	}

	/**
	 * DoAllTheSensorThings
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async DoAllTheMotionSensorThings(Group) {
		this.writeLog(`[ DoAllTheMotionSensorThings ] Reaching, Group = "${Group}`);

		if (!Array.isArray(this.LightGroups?.[Group]?.sensors)) {
			this.writeLog(
				`[ DoAllTheMotionSensorThings ] sensors in group="${Group} not a array or not iterable or not defined!", "warn"`,
			);
			return;
		}

		for (const sensor of this.LightGroups[Group].sensors) {
			try {
				const _motionState = await this.getForeignStateAsync(sensor.oid);
				if (_motionState) {
					sensor.isMotion = _motionState.val == sensor.motionVal;
					this.log.debug(
						`[ DoAllTheMotionSensorThings ] Group="${Group}" SensorID="${sensor.oid}" MotionVal="${sensor.isMotion}"`,
					);
					await this.subscribeForeignStatesAsync(sensor.oid);
					this.MotionSensors.push(sensor.oid);
				} else {
					this.log.debug(
						`[ DoAllTheMotionSensorThings ] Group="${Group}" ${sensor.oid} has no data, skipping subscribe`,
					);
				}
			} catch (error) {
				this.writeLog(
					`[ DoAllTheMotionSensorThings ] Not able to get state of motion sensor (${sensor})! Error: ${error}`,
					"warn",
				);
				return;
			}
		}
		return true;
	}

	/**
	 * DoAllTheLuxSensorThings
	 * @description Read the current lux value per group. However, if no individual lux sensor has been defined, a global lux sensor is assigned to the group.
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async DoAllTheLuxSensorThings(Group) {
		const luxSensor = this.LightGroups[Group].LuxSensor || this.config.GlobalLuxSensor;
		this.LightGroups[Group].actualLux = 0;

		if (!luxSensor) {
			this.writeLog(
				`[ DoAllTheLuxSensorThings ] No Luxsensor for Group="${Group}" defined, set actualLux = 0, skip handling`,
			);
			return;
		}

		if (luxSensor === this.config.GlobalLuxSensor) {
			this.LightGroups[Group].actualLux = this.ActualGenericLux ?? null;
			this.LightGroups[Group].LuxSensor = luxSensor;
			this.writeLog(`[ DoAllTheLuxSensorThings ] Group "${Group}" using global luxsensor.`);
			return;
		}

		const individualLux = await this.getForeignStateAsync(luxSensor).catch((error) => {
			this.writeLog(error, "error", "DoAllTheLuxSensorThings");
			return;
		});
		const _individualLux = helper.checkObjectNumber(individualLux);

		if (_individualLux === null) {
			this.log.warn(
				`[ DoAllTheLuxSensorThings ] state value of id="${luxSensor}" of Group="${Group}" is empty, null or undefined!`,
			);
			return;
		}

		this.LightGroups[Group].actualLux = _individualLux;
		await this.subscribeForeignStatesAsync(luxSensor);
		this.LuxSensors.push(luxSensor);
		this.writeLog(
			`[ DoAllTheLuxSensorThings ] Group="${Group}" using individual luxsensor "${luxSensor}", value is: ${this.LightGroups[Group].actualLux}`,
		);
	}

	/**
	 * GlobalPresenceHandlingAsync
	 */
	async GlobalPresenceHandlingAsync() {
		if (this.config.PresenceCountDp) {
			this.writeLog(`[ GlobalPresenceHandlingAsync ] PresenceCounteDp=${this.config.PresenceCountDp}`);
			this.ActualPresenceCount = { newVal: 0, oldVal: 0 };

			const ActualPresenceCount = await this.getForeignStateAsync(this.config.PresenceCountDp);
			const _ActualPresenceCount = await helper.checkObjectNumber(ActualPresenceCount);

			if (_ActualPresenceCount === null) {
				this.log.warn(
					`[ GlobalPresenceHandlingAsync ] state value of id="${this.config.PresenceCountDp}" is empty, null or undefined!`,
				);
				return;
			}

			this.ActualPresenceCount = { newVal: _ActualPresenceCount, oldVal: 0 };
			this.ActualPresence = this.ActualPresenceCount.newVal === 0 ? false : true;
			await this.subscribeForeignStatesAsync(this.config.PresenceCountDp);
		}

		if (this.config.IsPresenceDp) {
			this.writeLog(`[ GlobalPresenceHandlingAsync ] IsPresenceDp=${this.config.IsPresenceDp}`);
			this.ActualPresence = false;

			const ActualPresence = await this.getForeignStateAsync(this.config.IsPresenceDp);
			const _ActualPresence = await helper.checkObjectBoolean(ActualPresence);

			if (_ActualPresence === null) {
				this.writeLog(
					`[ GlobalPresenceHandlingAsync ] isPresenceDp=${this.config.IsPresenceDp} is not type="boolean"!`,
					"warn",
				);
				return;
			}

			this.ActualPresence = _ActualPresence;
			await this.subscribeForeignStatesAsync(this.config.IsPresenceDp);
		}
	}

	/**
	 * State create, extend objects and subscribe states
	 */
	async StatesCreateAsync() {
		const keepStates = [];
		const keepChannels = [];
		const keepDevices = [];

		keepStates.push("info.connection");
		keepChannels.push("info");

		//Loop LightGroups and create devices
		for (const Group in this.LightGroups) {
			if (Group === "All") continue;
			//Create device if not exist
			await this.CreateDevice(Group, Group);
			keepDevices.push(Group);

			await this.DoAllTheMotionSensorThings(Group);
			await this.DoAllTheLuxSensorThings(Group);

			for (const prop1 in DeviceTemplate) {
				const dp = Group + "." + prop1;
				// Check for second layer
				if (typeof DeviceTemplate[prop1].name == "undefined") {
					//Create channel if not exist
					await this.CreateChannel(dp, Group + " " + prop1);
					keepChannels.push(dp);

					for (const key in DeviceTemplate[prop1]) {
						const dp = `${Group}.${prop1}.${key}`;
						const common = DeviceTemplate[prop1][key];

						await this.CreateStatesAsync(dp, common);
						keepStates.push(dp);

						try {
							const state = await this.getStateAsync(dp);

							if (!state) {
								this.writeLog(
									`[ StatesCreateAsync ] State: "${dp}" is NULL or undefined! Init aborted!`,
									"warn",
								);
								return;
							}
							await this.SetValueToObjectAsync(Group, `${prop1}.${key}`, state.val);
							common.write && (await this.subscribeStatesAsync(dp));
						} catch (error) {
							this.writeLog(
								`[ StatesCreateAsync ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
								"warn",
							);
							return;
						}
					}
				} else {
					const common = DeviceTemplate[prop1];
					await this.CreateStatesAsync(dp, common);
					keepStates.push(dp);

					try {
						const state = await this.getStateAsync(dp);

						if (!state) {
							this.writeLog(
								`[ StatesCreateAsync ] State: "${dp}" is NULL or undefined! Init aborted!`,
								"warn",
							);
							return;
						}

						if (prop1 === "power") {
							this.writeLog(
								`[ StatesCreateAsync ] Group="${Group}", Prop1="${prop1}", powerNewVal="${state.val}"`,
							);
							await this.SetValueToObjectAsync(Group, "powerNewVal", state.val);
						}

						if (state) {
							await this.SetValueToObjectAsync(Group, prop1, state.val);
						}

						common.write && (await this.subscribeStatesAsync(dp));
					} catch (error) {
						this.writeLog(
							`[ StatesCreateAsync ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
							"warn",
						);
						return;
					}
				}
			}

			await this.SetValueToObjectAsync(Group, ["autoOnLux.dailyLockCounter", "autoOffLux.dailyLockCounter"], 0);
		}

		//Create All-Channel if not exists
		await this.CreateDevice("All", "Controll all groups together");
		keepDevices.push("All");

		for (const prop1 in DeviceAllTemplate) {
			const dp = "All." + prop1;
			const common = DeviceAllTemplate[prop1];

			await this.CreateStatesAsync(dp, common);
			keepStates.push(dp);

			try {
				const state = await this.getStateAsync(dp);

				if (!state) {
					this.writeLog(`[ StateCreate ] State: "${dp}" is NULL or undefined! Init aborted`, "warn");
					return;
				}

				if (prop1 === "power") {
					this.writeLog(`[ StateCreate ] Group="All", Prop1="${prop1}", powerNewVal="${state.val}"`);
					await this.SetValueToObjectAsync("All", "powerNewVal", state.val);
				}

				await this.SetValueToObjectAsync("All", dp, state.val);

				common.write && (await this.subscribeStatesAsync(dp));
			} catch (error) {
				this.writeLog(
					`[ StatesCreateAsync ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
					"warn",
				);
				return;
			}
		}

		// Delete non existent states, channels and devices
		const allStates = [];
		const allChannels = [];
		const allDevices = [];

		try {
			const objects = await this.getAdapterObjectsAsync();
			for (const o in objects) {
				const parts = o.split(".");
				if (parts[2] != "info") {
					const id = helper.removeNamespace(this.namespace, objects[o]._id);

					if (objects[o].type == "state") {
						allStates.push(id);
					} else if (objects[o].type == "channel") {
						allChannels.push(id);
					} else if (objects[o].type == "device") {
						allDevices.push(id);
					}
				}
			}
		} catch (error) {
			this.writeLog(`[ StatesCreateAsync ] not able to getObjects! Init aborted! Error: ${error}`, "warn");
			return;
		}

		for (let i = 0; i < allStates.length; i++) {
			const id = allStates[i];
			if (keepStates.indexOf(id) === -1) {
				try {
					await this.delObjectAsync(id, { recursive: true });
					this.writeLog("[ StateCreate ] State deleted " + id);
				} catch (error) {
					this.writeLog(`[ StateCreate ] Not able to delete state="${id}". Error: ${error}`, "warn");
				}
			}
		}
		for (let i = 0; i < allChannels.length; i++) {
			const id = allChannels[i];
			if (keepChannels.indexOf(id) === -1) {
				try {
					await this.delObjectAsync(id, { recursive: true });
					this.writeLog("[ StateCreate ] Channel deleted " + id);
				} catch (error) {
					this.writeLog(`[ StateCreate ] Not able to delete channel="${id}". Error: ${error}`, "warn");
				}
			}
		}
		for (let i = 0; i < allDevices.length; i++) {
			const id = allDevices[i];
			if (keepDevices.indexOf(id) === -1) {
				try {
					await this.delObjectAsync(id, { recursive: true });
					this.writeLog("[ StateCreate ] Device deleted " + id);
				} catch (error) {
					this.writeLog(`[ StateCreate ] Not able to delete device="${id}". Error: ${error}`, "warn");
				}
			}
		}

		return true;
	}

	/**
	 * clean Dev_Mode userdata
	 */
	async CleanUserData() {
		const id = "0_userdata.0.lightcontrol_DEV.";
		try {
			await this.delObjectAsync(id, { recursive: true });
			this.writeLog("[ CleanUserData ] Testdata deleted " + id);
		} catch (error) {
			this.writeLog(`[ CleanUserData ] Not able to delete testdata. Error: ${error}`, "warn");
		}
	}

	/**
	 * State create, extend objects and subscribe states
	 */
	async TestStatesCreateAsync() {
		this.writeLog("[ TestStatesCreate ]Creating Test devices...");

		const userdata = "0_userdata.0.lightcontrol_DEV.";

		//Loop TestLamps and create datapoints to 0_userdata.0
		await Promise.all(
			Object.keys(TestTemplateLamps).map(async (Lamp) => {
				//Create Lamp if not exist
				try {
					await this.setForeignObjectNotExistsAsync(userdata + "Lamps." + Lamp, {
						type: "channel",
						common: { name: Lamp },
						native: {},
					});
				} catch (error) {
					this.writeLog(`[ TestStatesCreate ] Not able create lamps of testdata. Error: ${error}`, "warn");
				}

				await Promise.all(
					Object.keys(TestTemplateLamps[Lamp]).map(async (prop1) => {
						const common = TestTemplateLamps[Lamp][prop1];
						const dp = userdata + "Lamps." + Lamp + "." + prop1;
						await this.CreateStatesAsync(dp, common, true);
					}),
				);
			}),
		);

		//Loop Test Motion Sensors and create datapoints to 0_userdata.0
		await Promise.all(
			Object.keys(TestTemplateMotionSensors).map(async (MotionSensor) => {
				const common = TestTemplateMotionSensors[MotionSensor];
				const dp = userdata + "MotionSensors." + MotionSensor;
				await this.CreateStatesAsync(dp, common, true);
			}),
		);

		//Loop Test Lux Sensors and create datapoints to 0_userdata.0
		await Promise.all(
			Object.keys(TestTemplateLuxSensors).map(async (LuxSensor) => {
				const common = TestTemplateLuxSensors[LuxSensor];
				const dp = userdata + "LuxSensors." + LuxSensor;
				await this.CreateStatesAsync(dp, common, true);
			}),
		);

		//Loop Test Presence and create datapoints to 0_userdata.0
		await Promise.all(
			Object.keys(TestTemplatePresence).map(async (Presence) => {
				const common = TestTemplatePresence[Presence];
				const dp = userdata + "Presence." + Presence;
				await this.CreateStatesAsync(dp, common, true);
			}),
		);
	}

	/**
	 * Create datapoint and extend datapoints
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {ioBroker.StateCommon} common type of datapoint, e.g. string, number, boolean, ...
	 * @param {boolean} [foreign = false] set adapter states = false; set foreign states = true
	 */
	async CreateStatesAsync(dp, common, foreign) {
		try {
			const obj = !foreign ? await this.getObjectAsync(dp) : await this.getForeignObjectAsync(dp);

			if (!obj) {
				/** @type {ioBroker.SettableStateObject} */
				const obj = {
					type: "state",
					common: common,
					native: {},
				};

				await (foreign ? this.setForeignObjectAsync(dp, obj) : this.setObjectAsync(dp, obj));
				this.writeLog(`[ CreateStatesAsync ] State: ${dp} created.`);
			} else {
				if (JSON.stringify(obj.common) !== JSON.stringify(common) || !("native" in obj)) {
					obj.common = common;
					obj.native = obj.native ?? {};
					await (foreign ? this.setForeignObjectAsync(dp, obj) : this.setObjectAsync(dp, obj));
				}
			}
		} catch (error) {
			this.writeLog(`[ CreateStatesAsync ] Not able create state or getObject (${dp}). Error: ${error}`, "warn");
		}
	}
	/**
	 * Create channel and extend
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {string} name name of the channel
	 */
	async CreateChannel(dp, name) {
		try {
			await this.extendObjectAsync(dp, {
				type: "channel",
				common: {
					name: name,
				},
				native: {},
			});
		} catch (error) {
			this.writeLog(`[ CreateChannel ] Not able create channel (${dp}). Error: ${error}`, "warn");
		}
	}
	/**
	 * Create device and extend
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {string} name name of the channel
	 */
	async CreateDevice(dp, name) {
		try {
			await this.extendObjectAsync(dp, {
				type: "device",
				common: {
					name: name,
				},
				native: {},
			});
		} catch (error) {
			this.writeLog(`[ CreateDevice ] Not able create device (${dp}). Error: ${error}`, "warn");
		}
	}

	/**
	 * Init all Custom states
	 * @async
	 * @description Init all Custom states
	 */
	async InitCustomStatesAsync() {
		// Get all objects with custom configuration items
		const customStateArray = await this.getObjectViewAsync("system", "custom", {}).catch((error) => {
			this.writeLog(error, "error", "InitCustomStatesAsync");
			return;
		});
		this.writeLog(`[ InitCustomStatesAsync ] All states with custom items : ${JSON.stringify(customStateArray)}`);

		// List all states with custom configuration
		if (customStateArray && customStateArray.rows) {
			// Verify first if result is not empty

			// Loop truth all states and check if state is activated for LightControl
			for (const row of customStateArray.rows) {
				const { value, id } = row;
				if (value && value[this.namespace]) {
					this.writeLog(`[ InitCustomStatesAsync ] LightControl configuration found`);

					// Simplify stateID
					const stateID = id;

					// Check if its an own Lightcontrol State
					if (stateID.includes(this.namespace)) {
						await this.deactivateOwnIdAsync(stateID);
						continue;
					}

					// Check if custom object is enabled for LightControl
					if (value[this.namespace].enabled) {
						if (!this.activeStates.includes(stateID)) this.activeStates.push(stateID);
						this.writeLog(`[ InitCustomStatesAsync ] LightControl enabled state found ${stateID}`);
					} else {
						this.writeLog(
							`[ InitCustomStatesAsync ] LightControl configuration found but not Enabled, skipping ${stateID}`,
						);
					}
				}
			}
		}

		let totalInitiatedStates = 0;
		let totalFailedStates = 0;
		const totalEnabledStates = this.activeStates.length;
		this.writeLog(`Found ${totalEnabledStates} LightControl enabled states`, "info");

		for (const [index, stateID] of this.activeStates.entries()) {
			this.writeLog(
				`[ InitCustomStatesAsync ] Initializing (${index + 1} of ${totalEnabledStates}) "${stateID}"`,
			);

			await this.checkLightGroupParameterAsync(stateID);

			if (this.activeStates.includes(stateID)) {
				totalInitiatedStates++;
				this.writeLog(`Initialization of ${stateID} successfully`, "info");
			} else {
				totalFailedStates++;
				this.writeLog(
					`[ InitCustomStatesAsync ] Initialization of ${stateID} failed, check warn messages!`,
					"warn",
				);
			}
		}

		// Subscribe on all foreign objects to detect (de)activation of LightControl enabled states
		await this.subscribeForeignObjectsAsync("*");
		this.writeLog(
			`[ InitCustomStatesAsync ] Subscribed to all foreign objects to detect (de)activation of LightControl enabled states`,
		);

		if (totalFailedStates > 0) {
			this.writeLog(
				`[ InitCustomStatesAsync ] Cannot handle calculations for ${totalFailedStates} of ${totalEnabledStates} enabled states, check error messages`,
				"warn",
			);
		}

		this.writeLog(
			`Successfully activated LightControl for ${totalInitiatedStates} of ${totalEnabledStates} states, will do my Job until you stop me!`,
			"info",
		);
	}

	/**
	 * Check if group availabe in LightGrous
	 * @async
	 * @param {string} stateID
	 * @returns
	 */
	async checkLightGroupParameterAsync(stateID) {
		this.writeLog(`[ checkLightGroupParameter ] started for ${stateID}`);

		let stateInfo;
		try {
			// Load configuration as provided in object
			/** @type {ioBroker.StateObject} */
			stateInfo = await this.getForeignObjectAsync(stateID);

			if (!stateInfo) {
				this.writeLog(
					`[ checkLightGroupParameter ] Can't get information for ${stateID}, state will be ignored`,
					"warn",
				);
				this.activeStates = helper.removeValue(this.activeStates, stateID);
				this.unsubscribeForeignStates(stateID);
				return;
			}
		} catch (error) {
			this.writeLog(
				`[ checkLightGroupParameter ] ${stateID} is incorrectly correctly formatted, ${JSON.stringify(error)}`,
				"error",
			);
			this.activeStates = helper.removeValue(this.activeStates, stateID);
			this.unsubscribeForeignStates(stateID);
			return;
		}

		// Check if configuration for LightControl is present, trow error in case of issue in configuration
		if (stateInfo && stateInfo.common && stateInfo.common.custom && stateInfo.common.custom[this.namespace]) {
			const customData = stateInfo.common.custom[this.namespace];

			//Check if a groupname(s) defined
			if (!customData.group) {
				this.writeLog(
					`[ checkLightGroupParameter ] No Group Name defined for StateID: ${stateID}. Initalisation aborted`,
					"warn",
				);
				return;
			}

			if (Array.isArray(customData.group)) {
				this.log.debug(`[ checkLightGroupParameter ] LightGroups: ${JSON.stringify(this.LightGroups)}`);
				const missingGroups = customData.group.filter(
					(group) => !Object.prototype.hasOwnProperty.call(this.LightGroups, group),
				);

				if (missingGroups.length > 0) {
					if (this.config.deleteUnusedConfig) {
						this.writeLog(
							`[ checkLightGroupParameter ] Light group(s) "${missingGroups.join(
								", ",
							)}" were deleted by the user in the instance settings! LightControl settings will be updated for this StateID: ${stateID})`,
							"warn",
						);
						const newGroups = customData.group.filter((group) => !missingGroups.includes(group));

						stateInfo.common.custom[this.namespace].group =
							newGroups.length === 1 ? newGroups[0].toString() : newGroups;
						stateInfo.common.custom[this.namespace].enabled = newGroups.length > 0;

						this.writeLog(
							`[ checkLightGroupParameter ] Object after deactivating: ${JSON.stringify(stateInfo)}`,
						);

						await this.setForeignObjectAsync(stateID, stateInfo);
					} else {
						this.writeLog(
							`[ checkLightGroupParameter ] Light group(s) "${missingGroups.join(
								", ",
							)}" were deleted by the user in the instance settings! (StateID: ${stateID})`,
							"warn",
						);
					}
					return;
				}

				for (const group of customData.group) {
					customData.oid = stateID;
					customData.group = group;
					await this.buildLightGroupParameterAsync(customData);
				}
			} else {
				if (!Object.prototype.hasOwnProperty.call(this.LightGroups, customData.group)) {
					if (this.config.deleteUnusedConfig) {
						this.writeLog(
							`[ checkLightGroupParameter ] Light group "${customData.group}" was deleted by the user in the instance settings! LightControl settings will be deactivated for this StateID: ${stateID})`,
							"warn",
						);

						stateInfo.common.custom[this.namespace].enabled = false;

						this.writeLog(
							`[ checkLightGroupParameter ] Object after deactivating: ${JSON.stringify(stateInfo)}`,
						);

						await this.setForeignObjectAsync(stateID, stateInfo);
					} else {
						this.writeLog(
							`[ checkLightGroupParameter ] Light group "${customData.group}" was deleted by the user in the instance settings! (StateID: ${stateID})`,
							"warn",
						);
					}

					return;
				} else {
					customData.oid = stateID;
					await this.buildLightGroupParameterAsync(customData);
				}
			}
		}
	}

	/**
	 * Load state definitions to memory this.activeStates[stateID]
	 * @param {object} customData ID  of state to refresh memory values
	 *
	 */
	async buildLightGroupParameterAsync(customData) {
		//const commonData = stateInfo.common;
		this.writeLog(`[ buildLightGroupParameterAsync ] customData ${JSON.stringify(customData)}`);

		//Covert string to boolean and numbers
		for (const key in customData) {
			const val = customData[key];
			if (val === "false") {
				customData[key] = false;
			} else if (val === "true") {
				customData[key] = true;
			} else if (parseFloat(val)) {
				customData[key] = parseFloat(val);
			}
		}
		/*
		CustomData Example
		{
			"enabled": true,
			"defaultBri": "100",
			"whiteModeVal": "false",
			"colorModeVal": "true",
			"colorType": "hex",
			"defaultColor": "#FFFFFF",
			"sendCt": true,
			"sendSat": true,
			"sendColor": true,
			"sendModeswitch": true,
			"useBri": true,
			"type": "light",
			"func": "bri",
			"onVal": 1,
			"offVal": 0,
			"minVal": 0,
			"maxVal": 100,
			"unit": "s",
			"motionVal": "On",
			"noMotionVal": "Off",
			"group": "Wohnzimmer",
			"description": "Licht1"
			}
		*/

		// Function to reduce the customData
		const getSubset = (obj, ...keys) => keys.reduce((a, c) => ({ ...a, [c]: obj[c] }), {});

		switch (customData.type) {
			case "light": {
				//Check if a Lightname is available
				if (!customData.description) {
					this.writeLog(
						`[ buildLightGroupParameterAsync ] No Lightname defined. Initalisiation aborted`,
						"warn",
					);
					return;
				}

				if (
					this.LightGroups[customData.group].lights &&
					Array.isArray(this.LightGroups[customData.group].lights)
				) {
					const Lights = this.LightGroups[customData.group].lights;

					// Überprüfen, ob jedes Objekt eine description-Eigenschaft hat
					const allObjectsHaveDescription = Lights.every((x) => x && typeof x.description === "string");

					if (allObjectsHaveDescription) {
						///Find index in Lights Array if description available
						const index = Lights.findIndex((x) => x.description === customData.description);

						let Light;

						if (helper.isNegative(index)) {
							Light = Lights.length === 0 ? (Lights[0] = {}) : (Lights[Lights.length] = {});
						} else {
							Light = Lights[index];
						}

						// Add parameters to Light
						Light.description = customData.description;
						Light[customData.func] = getSubset(customData, ...params[customData.func]);

						this.writeLog(
							`[ buildLightGroupParameterAsync ] Type: Light, in Group: ${
								this.LightGroups[customData.group].description
							} with Lights: ${JSON.stringify(Lights)} and Light: ${JSON.stringify(
								Light,
							)} with Index: ${index}`,
						);
					} else {
						this.writeLog(
							`[ buildLightGroupParameterAsync ] Any Light of Group=${
								this.LightGroups[customData.group].description
							} has no own description. Init aborted`,
							"warn",
						);
					}
				} else {
					this.writeLog(
						`Any Light has no description. Init aborted. No Index found: ${JSON.stringify(
							this.LightGroups[customData.group].lights,
						)}`,
						"error",
						"buildLightGroupParameterAsync",
					);
					return;
				}

				break;
			}
			case "sensor": {
				this.writeLog(
					`[ buildLightGroupParameterAsync ] Type: Sensor in Group ${
						this.LightGroups[customData.group].description
					}}`,
				);
				const Sensors = this.LightGroups[customData.group].sensors;
				Sensors.push({
					oid: customData.oid,
					motionVal: customData.motionVal,
					noMotionVal: customData.noMotionVal,
				});

				await this.DoAllTheMotionSensorThings(customData.group);

				break;
			}
			default:
				break;
		}

		//Push stateID after processing
		if (!this.activeStates.includes(customData.oid)) this.activeStates.push(customData.oid);

		this.writeLog(`[ buildLightGroupParameterAsync ] completed for ${customData.oid}.`);
		this.writeLog(`[ buildLightGroupParameterAsync ] Updated LightGroups: ${JSON.stringify(this.LightGroups)}`);
		return true;
	}

	/**
	 * SummarizeSensors
	 * @async
	 * @param {string} Group
	 */
	async SummarizeSensorsAync(Group) {
		this.writeLog(`[ SummarizeSensors ] Reaching, Group="${Group}"`);

		let Motionstate = false;

		for (const Sensor of this.LightGroups[Group].sensors) {
			if (Sensor.isMotion) {
				this.writeLog(
					`[ SummarizeSensors ] Group="${Group}" Sensor with target "${Sensor.oid}" has value ${Sensor.isMotion}`,
				);
				Motionstate = true;
			}
		}

		if (this.LightGroups[Group].isMotion !== Motionstate) {
			this.writeLog(
				`[ SummarizeSensors ] Summarized IsMotion for Group="${Group}" = ${Motionstate}, go to Controller...`,
			);
			this.LightGroups[Group].isMotion = Motionstate;
			await this.setStateAsync(Group + ".isMotion", Motionstate, true);
			await this.ControllerAsync(Group, "isMotion", this.LightGroups[Group].isMotion, Motionstate);
		} else {
			this.writeLog(
				`[ SummarizeSensors ] Motionstate="${Group}" = ${Motionstate}, nothing changed -> nothin to do`,
			);
		}
		return true;
	}

	/**
	 * Get System Longitude and Latitute
	 */
	async GetSystemDataAsync() {
		const obj = await this.getForeignObjectAsync("system.config");

		if (obj && obj.common && obj.common.longitude && obj.common.latitude) {
			this.lng = obj.common.longitude;
			this.lat = obj.common.latitude;

			this.writeLog(`[ GetSystemDataAsync ] longitude: ${this.lng} | latitude: ${this.lat}`);
			return true;
		} else {
			this.writeLog(
				"system settings cannot be called up (Longitute, Latitude). Please check your ioBroker configuration!",
				"warn",
			);
			return false;
		}
	}

	/**
	 * Set anyOn and Masterswitch Light State
	 * @param {string} from From which Function?
	 */
	async SetLightStateAsync(from = "noFunction") {
		const countGroups = this.countGroups();
		const groupLength = Object.keys(this.LightGroups).length - 1;

		await Promise.all([
			this.SetValueToObjectAsync("All", "anyOn", countGroups > 0),
			this.SetValueToObjectAsync("All", "power", countGroups === groupLength),
		]);

		await Promise.all([
			this.setStateAsync("All.anyOn", this.LightGroups.All.anyOn, true),
			this.setStateAsync("All.power", this.LightGroups.All.power, true),
		]);
		this.writeLog(
			`[ SetLightState ] Set State "All.anyOn" to ${this.LightGroups.All.anyOn} from function="${from}"`,
		);
	}

	/**
	 * Helper: count Power in Groups
	 */
	countGroups() {
		let i = 0;
		for (const Group in this.LightGroups) {
			if (Group === "All") continue;

			if (this.LightGroups[Group].power) {
				i++;
			}
		}
		return i;
	}

	/**
	 * deactivate state id because it's an own lightcontrol id
	 * @async
	 * @param {string} stateID ID of the Object
	 * @returns {Promise<boolean>}
	 */
	async deactivateOwnIdAsync(stateID) {
		this.writeLog(
			`[ InitCustomStates ] This Object-ID: "${stateID}" is not allowed, because it's an LightControl State! The settings will be deaktivated automatically!`,
			"warn",
		);
		const stateInfo = await this.getForeignObjectAsync(stateID);
		if (stateInfo?.common?.custom) {
			stateInfo.common.custom[this.namespace].enabled = false;
			await this.setForeignObjectAsync(stateID, stateInfo).catch((error) => {
				this.writeLog(error, "error", "deaktivateOwnIdAsync");
				return;
			});
		}
		return true;
	}

	/**
	 * deleteStateIdFromLightGroups
	 * @param {string} stateID ID of the Object
	 */
	deleteStateIdFromLightGroups(stateID) {
		// Loop trough LighGroups and delete Object by oid value
		const keys = Object.keys(params);
		for (const Groups of Object.keys(this.LightGroups)) {
			//Check Lights
			const lightArray = this.LightGroups[Groups].lights;
			if (lightArray) {
				for (const Lights of lightArray) {
					keys.forEach((key) => {
						if (Lights[key]) {
							if (Lights[key].oid === stateID) {
								this.writeLog(
									`ID = ${stateID} will delete in Group = "${this.LightGroups[Groups].description}", Param = ${key}`,
									"info",
								);
								delete Lights[key];
							}
						}
					});
				}
				// Delete complete Light Object if it copntains only description property
				for (let i = lightArray.length - 1; i >= 0; i--) {
					const count = Object.keys(lightArray[i]).length;
					if (count === 1) {
						this.writeLog(
							`Light: ${lightArray[i].description} will be deleted, because no Object-IDs are defined.`,
							"info",
						);
						lightArray.splice(i, 1);
					}
				}
			}
			//Check Sensors
			const _oldArray = this.LightGroups[Groups].sensors;
			if (_oldArray && _oldArray !== "undefined") {
				this.LightGroups[Groups].sensors = this.LightGroups[Groups].sensors.filter((object) => {
					return object.oid !== stateID;
				});

				// Comparing Sensor Array
				const equalsCheck = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
				if (!equalsCheck(_oldArray, this.LightGroups[Groups].sensors)) {
					this.writeLog(
						`Sensor with ID = ${stateID} will delete in Group = "${this.LightGroups[Groups].description}"`,
						"info",
					);
				}
			}
		}
	}

	/**
	 * Set Values and Keys to Object
	 * @async
	 * @function SetValueToObject
	 * @description Fügt Schlüssel-Wert-Paare zu den Lichtgruppen hinzu.
	 * @param {string} Group - Der Name der Lichtgruppe.
	 * @param {string|string[]} key - Der Schlüssel oder ein Array von Schlüsseln.
	 * @param {*} value - Der Wert, der den Schlüsseln zugeordnet wird.
	 * @example
	 * await helper.SetValueToObject(LightGroups[Group], ["blink.stop", "blink.infinite"], false);
	 * await helper.SetValueToObject(LightGroups[Group], prop1, false);
	 */
	async SetValueToObjectAsync(Group, key, value) {
		if (!Object.prototype.hasOwnProperty.call(this.LightGroups, Group)) {
			this.log.warn(`[ SetValueToObjectAsync ] Group="${Group}" not exist in LightGroups-Object!`);
			return;
		}

		if (value === null || value === undefined) {
			this.log.error(
				`[ SetValueToObjectAsync ] Value="${value}" is undefined or null. check your config and restart adapter!`,
			);
			return;
		}

		const group = this.LightGroups[Group];
		if (Array.isArray(key)) {
			if (
				typeof value === "string" ||
				typeof value === "boolean" ||
				typeof value === "number" ||
				(Array.isArray(value) && value.length === key.length)
			) {
				key.forEach((k, index) => {
					const keys = k.split(".");
					let currentObj = group;
					for (let i = 0; i < keys.length - 1; i++) {
						const keyPart = keys[i];
						if (!Object.prototype.hasOwnProperty.call(currentObj, keyPart)) {
							currentObj[keyPart] = {};
						}
						currentObj = currentObj[keyPart];
					}
					const lastKey = keys[keys.length - 1];
					currentObj[lastKey] = Array.isArray(value) ? value[index] : value;
				});
			} else {
				this.log.warn(
					`[ SetValueToObjectAsync ] Fehler: Die Länge des Wertearrays stimmt nicht mit der Länge des Key-Arrays überein.`,
				);
			}
		} else {
			const keys = key.split(".");
			let currentObj = group;
			for (let i = 0; i < keys.length - 1; i++) {
				const keyPart = keys[i];
				if (!Object.prototype.hasOwnProperty.call(currentObj, keyPart)) {
					currentObj[keyPart] = {};
				}
				currentObj = currentObj[keyPart];
			}
			const lastKey = keys[keys.length - 1];
			currentObj[lastKey] = value;
		}
		return true;
	}

	/**
	 * a function for log output
	 * @function
	 * @param {string} logtext
	 * @param {string} logtype ("silly" | "info" | "debug" | "warn" | "error")
	 * @param {string} funcName Extended info. Example the name of the function
	 */
	writeLog(logtext, logtype = "debug", funcName = "") {
		const logFunctions = {
			silly: this.log.silly,
			info: this.log.info,
			debug: this.log.debug,
			warn: this.log.warn,
			error: this.log.error,
		};
		const logFn = logFunctions[logtype];
		if (logFn) {
			logFn(`${funcName ? `[ ${funcName} ] ` : ""} ${logtext}`);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Lightcontrol(options);
} else {
	// otherwise start the instance directly
	new Lightcontrol();
}
