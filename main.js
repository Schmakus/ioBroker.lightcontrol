"use strict";
const utils = require("@iobroker/adapter-core");
const helper = require("./lib/helper");
const checks = require("./lib/checks");

const SunCalc = require("suncalc2");
const { compareTime, getDateObject, convertTime, getAstroDate } = require("./lib/helper");
const converters = require("./lib/converters");
const { params } = require("./lib/params");
const objects = require("./lib/objects");

const LightGroups = {};
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
		this.LuxSensors = [];
		this.MotionSensors = [];

		this.keepList = [];
		this.activeStates = [];

		this.connection = false;

		this.ActualGenericLux = 0;
		this.ActualPresence = false;
		this.ActualPresenceCount = { newVal: 0, oldVal: 0 };

		this.RampTimeoutObject = {};
		this.TransitionTimeoutObject = {};
		this.AutoOffTimeoutObject = {};
		this.BlinkIntervalObj = {};

		this.lat = "";
		this.lng = "";
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.instanceReady(false);
		this.writeLog(`[ onReady ] LightGroups from Settings: ${JSON.stringify(this.config?.LightGroups)}`);

		//Create LightGroups Object from GroupNames
		await this.CreateLightGroupsObject();

		//Create all States, Devices and Channels
		if (Object.keys(LightGroups).length !== 0) {
			const init = await this.InitAsync();
			if (init) {
				await this.instanceReady(true);
			}
		} else {
			this.writeLog(`[ onReady ] No Init because no LightGroups defined in settings`, "warn");
			await this.instanceReady(false);
		}
	}

	/**
	 *
	 * @param {boolean} value
	 */
	async instanceReady(value) {
		await this.setStateAsync("info.connection", { val: value, ack: true });
		this.connection = value;
		return true;
	}
	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.clearRampTimeoutsAsync(null);
			this.clearTransitionTimeoutAsync(null);
			this.clearBlinkIntervalsAsync(null);
			this.clearAutoOffTimeoutsAsync(null);
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
		if (!id || !state || !this.connection) {
			return;
		}
		const ids = id.split(".");

		if (state.val !== null) {
			if (ids[0] === "lightcontrol" && !state.ack) {
				const NewVal = state.val;

				const OwnId = helper.removeNamespace(this.namespace, id);
				const { Group, Prop } = helper.ExtractGroupAndProp(OwnId);

				if (!Object.prototype.hasOwnProperty.call(LightGroups, Group)) {
					this.writeLog(
						`Group "${Group}" not defined in LightGroups! Please check your settings!`,
						"warn",
						"onStateChange",
					);
					return;
				}

				this.writeLog(
					`[ onStateChange ] Internal state: ${id} triggered: ${state.val} (ack = ${state.ack}) in Group: ${Group}`,
				);

				if (Group === "All") {
					await this.SetMasterPowerAsync(NewVal);
				} else {
					await this.ControllerAsync(Group, Prop, NewVal, OwnId);
				}
			} else if (ids[0] !== "lightcontrol" && state.ack) {
				//Handle External States
				this.writeLog(
					`[ onStateChange ] External state: ${id} triggered: ${state.val} (ack = ${state.ack}). I'm checking for type..`,
				);

				//Check if it's a LuxSensor
				if (this.LuxSensors.includes(id)) {
					const groupsWithLuxSensor = Object.values(LightGroups).filter((Group) => Group.LuxSensor === id);

					for (const Group of groupsWithLuxSensor) {
						if (state.val !== Group.actualLux) {
							this.writeLog(
								`[ onStateChange ] It's a LuxSensor in following Group: ${Group.description} with value = ${state.val} (old value = ${Group.actualLux})`,
							);
							Group.actualLux = state.val;
							await this.ControllerAsync(Group.description, "actualLux", state.val, "");
						}
					}

					//Check if it's a MotionSensor
				} else if (this.MotionSensors.includes(id)) {
					await Promise.all(
						Object.keys(LightGroups)
							.filter((Group) => !["All", "info"].includes(Group))
							.flatMap((Group) => {
								const sensors = LightGroups[Group].sensors;
								if (Array.isArray(sensors)) {
									return sensors
										.filter((sensor) => sensor.oid === id)
										.map(async (sensor) => {
											const motionValue = state.val === sensor.motionVal;
											sensor.isMotion = motionValue;

											this.writeLog(
												`[ onStateChange ] It's a Sensor in following Group: ${Group}. This isMotion="${motionValue}"`,
											);

											await this.SummarizeSensorsAync(Group);
										});
								} else {
									this.writeLog(
										`[ onStateChange ] Sensors in Group="${Group}" is not iterable. Please check your config!`,
										"warn",
									);
									return [];
								}
							}),
					);

					//Check if it's Presence
				} else if (this.config?.IsPresenceDp === id) {
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
			} else if (ids[0] !== "lightcontrol" && !state.ack) {
				this.writeLog(
					`[ onStateChange ] state ${id} changed: ${state.val} (ack = ${state.ack}). External states should changed with ack=true!`,
					"warn",
				);
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
	 * @param {string} id Object-ID
	 */
	async ControllerAsync(Group, prop1, NewVal, id = "") {
		let handeled = false;

		this.writeLog(`[ Controller ] Reaching, Group="${Group}" Property="${prop1}" NewVal="${NewVal}"`, "info");

		if (prop1 !== "power") await this.SetValueToObjectAsync(Group, prop1, NewVal);

		switch (prop1) {
			case "actualLux":
				if (!LightGroups[Group].powerCleaningLight) {
					//Autofunktionen nur wenn Putzlicht nicht aktiv
					await this.AutoOnLuxAsync(Group);
					await this.AutoOffLuxAsync(Group);
					if (LightGroups[Group].adaptiveBri) {
						await this.SetBrightnessAsync(Group, this.AdaptiveBri(Group));
					}
					await this.AutoOnMotionAsync(Group);
				}
				handeled = true;
				break;
			case "isMotion":
				break;
			case "rampOn.time":
				handeled = true;
				break;
			case "rampOn.enabled":
				break;
			case "rampOn.switchOutletsLast":
				break;
			case "rampOff.time":
				handeled = true;
				break;
			case "rampOff.enabled":
				break;
			case "rampOff.switchOutletsLast":
				break;
			case "autoOffTimed.enabled":
				break;
			case "autoOffTimed.autoOffTime":
				break;
			case "autoOffTimed.countdown":
				break;
			case "autoOffTimed.noAutoOffWhenMotion":
				break;
			case "autoOffTimed.noticeBri":
				break;
			case "autoOffTimed.noticeTime":
				if (LightGroups[Group].autoOffTimed.autoOffTime <= LightGroups[Group].autoOffTimed.noticeTime) {
					await this.setStateAsync(`${Group}.autoOffTimed.noticeTime`, {
						val: LightGroups[Group].autoOffTimed.autoOffTime + 5,
						ack: true,
						q: 0x40,
					});
					this.writeLog(
						`Warning! noticeTime is less than autoOffTime! (Group="${Group}") We use substitute value = ${
							LightGroups[Group].autoOffTimed.autoOffTime + 5
						}`,
					);
				} else {
					await this.setStateAsync(`${Group}.autoOffTimed.noticeTime`, {
						val: NewVal,
						ack: true,
					});
				}
				handeled = true;
				break;
			case "autoOffTimed.noticeEnabled":
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
				await this.AutoOnLuxAsync(Group);
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
				await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "bri");
				await this.SetBrightnessAsync(Group, LightGroups[Group].bri);
				handeled = true;
				break;
			case "ct":
				await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "bri");
				await this.SetCtAsync(Group, LightGroups[Group].ct);
				await this.SetWhiteSubstituteColorAsync(Group);
				handeled = true;
				break;
			case "color":
				if (checks.CheckHex(NewVal)) {
					LightGroups[Group].color = NewVal.toUpperCase();
					await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "bri");
					await this.SetColorAsync(Group, LightGroups[Group].color);
					if (LightGroups[Group].color == "#FFFFFF") await this.SetWhiteSubstituteColorAsync(Group);
					await this.SetColorModeAsync(Group);
				}
				handeled = true;
				break;
			case "transitionTime":
				await this.SetTtAsync(Group, helper.limitNumber(NewVal, 0, 64000));
				handeled = true;
				break;
			case "power": {
				LightGroups[Group].powerOldVal = LightGroups[Group].powerNewVal;
				LightGroups[Group].powerNewVal = NewVal;

				LightGroups[Group].setBri = LightGroups[Group].bri;

				await this.GroupPowerOnOffAsync(Group, NewVal); //Alles schalten
				if (NewVal) {
					await this.PowerOnAftercareAsync(Group);
					await this.AutoOffTimedAsync(Group);
				}
				if (!NewVal && LightGroups[Group].autoOffTimed.enabled) {
					//Wenn ausschalten und autoOffTimed ist aktiv, dieses löschen, da sonst erneute ausschaltung nach Ablauf der Zeit. Ist zusätzlich rampon aktiv, führt dieses zu einem einschalten mit sofort folgenden ausschalten
					await this.clearAutoOffTimeoutsAsync(Group);
				}
				if (!NewVal && LightGroups[Group].powerCleaningLight) {
					//Wenn via Cleaninglight angeschaltet wurde, jetzt aber normal ausgeschaltet, powerCleaningLight synchen um Blockade der Autofunktionen zu vermeiden
					LightGroups[Group].powerCleaningLight = false;
					await this.setStateAsync(`${Group}.powerCleaningLight`, { val: false, ack: true });
				}
				handeled = true;
				break;
			}
			case "powerCleaningLight":
				await this.GroupPowerCleaningLightOnOffAsync(Group, NewVal);
				handeled = true;
				break;
			case "adaptiveBri":
				await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "adaptiveBri");
				await this.SetBrightnessAsync(Group, this.AdaptiveBri(Group));
				handeled = true;
				break;
			case "dimmUp":
				await this.setStateAsync(`${Group}.bri`, {
					val: Math.min(Math.max(LightGroups[Group].bri + LightGroups[Group].dimmAmount, 10), 100),
					ack: false,
				});
				handeled = true;
				break;
			case "dimmDown":
				await this.setStateAsync(`${Group}.bri`, {
					val: Math.min(Math.max(LightGroups[Group].bri - LightGroups[Group].dimmAmount, 2), 100),
					ack: false,
				});
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
				if (NewVal && NewVal !== LightGroups[Group].powerOldVal) {
					await this.SetTtAsync(Group, 0, "blink");
					await this.SetValueToObjectAsync(Group, ["blink.infinite", "blink.stop"], [true, false]);
					await this.BlinkAsync(Group);
				} else if (!NewVal) {
					await this.SetValueToObjectAsync(Group, "blink.stop", true);
					await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "blink");
				}
				handeled = true;
				break;
			case "blink.start":
				await this.SetTtAsync(Group, 0, "blink");
				await this.SetValueToObjectAsync(Group, ["blink.stop", "blink.infinite"], false);
				await this.BlinkAsync(Group);
				break;
			default:
				this.writeLog(`[ Controller ] Error, unknown or missing property: "${prop1}"`, "warn");
				handeled = true;
		}

		if (!handeled) {
			if (id !== "") {
				await this.setStateAsync(id, { val: NewVal, ack: true });
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
		if (!id || !obj || !this.connection) {
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
					`[ onObjectChange ] LightGroups after deactivation of ${stateID} : ${JSON.stringify(LightGroups)}`,
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
		if (!this.connection) {
			return;
		}
		this.writeLog(`[ onMessage ] Incomming Message from: ${JSON.stringify(msg)}`);
		if (msg.callback) {
			switch (msg.command) {
				case "LightGroup": {
					try {
						const groups = [];
						if (Object.keys(LightGroups).length !== 0) {
							for (const group of Object.keys(LightGroups)) {
								if (!["All", "info"].includes(group)) {
									groups.push({ value: group, label: group });
								}
							}
						}
						this.sendTo(msg.from, msg.command, groups, msg.callback);
						this.writeLog(`[ onMessage ] LightGroup => LightGroups Callback: ${JSON.stringify(groups)}.`);
					} catch (error) {
						this.writeLog(
							`Error: ${error.message}, Stack: ${error.stack}`,
							"error",
							"onMessage // case LightGroup",
						);
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
							lights.push(DEFAULT_LIGHT);
						}

						if (lightGroups && Array.isArray(lightGroups)) {
							for (const key of lightGroups) {
								if (Object.prototype.hasOwnProperty.call(LightGroups, key)) {
									const group = LightGroups[key];
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
						} else if (lightGroups && Object.prototype.hasOwnProperty.call(LightGroups, lightGroups)) {
							// Prüfe, ob lightGroups ein einzelner Schlüssel ist
							const group = LightGroups[lightGroups];
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
						this.writeLog(
							`Error: ${error.message}, Stack: ${error.stack}`,
							"error",
							`[ onMessage // case LightName ]`,
						);
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
						this.writeLog(
							`Error: ${error.message}, Stack: ${error.stack}`,
							"error",
							"onMessage // case checkIdForDuplicates",
						);
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
		if (!LightGroups[Group].lights.some((Light) => Light.power?.oid || Light.bri?.oid)) {
			this.writeLog(
				`[ GroupPowerOnOffAsync ] Not able to switching ${OnOff} for group="${Group}". No lights defined or no power or brightness states are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(
			`[ GroupPowerOnOff ] Group="${Group}", OnOff="${OnOff}" rampOn="${
				LightGroups[Group].rampOn.enabled
			}" - ${JSON.stringify(LightGroups[Group].rampOn)} rampOff="${
				LightGroups[Group].rampOff.enabled
			}" - ${JSON.stringify(LightGroups[Group].rampOff)}`,
			"info",
		);

		//Reset ramping state
		if ((OnOff && !LightGroups[Group].rampOff.enabled) || (!OnOff && !LightGroups[Group].rampOn.enabled)) {
			LightGroups[Group].ramping = "";
		}

		if (OnOff) {
			LightGroups[Group].power = true;
			//
			// ******* Anschalten ohne ramping * //
			//
			if (!LightGroups[Group].rampOn.enabled) {
				await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff");
				await this.SimpleGroupPowerOnOffAsync(Group, OnOff);
			} else {
				await this.TurnOnWithRampingAsync(Group);
			}
			await this.setStateAsync(`${Group}.power`, { val: OnOff, ack: true });
		} else {
			// Ausschalten ohne Ramping */
			if (!LightGroups[Group].rampOff.enabled) {
				await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff");
				if (LightGroups[Group].rampOn.enabled) {
					await this.SetBrightnessAsync(Group, 2);
				}
				await this.SimpleGroupPowerOnOffAsync(Group, OnOff);
				LightGroups[Group].power = false;
			} else {
				// Ausschalten mit Ramping */
				await this.TurnOffWithRampingAsync(Group);
			}
			await this.setStateAsync(`${Group}.power`, { val: OnOff, ack: true });
		}

		/*
		await Promise.all([
			this.setStateAsync(Group + ".power", OnOff, true),
			//this.SetLightStateAsync("GroupPowerOnOff"),
		]);
		*/
		return true;
	}

	/**
	 * SimpleGroupPowerOnOff
	 * @async
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async SimpleGroupPowerOnOffAsync(Group, OnOff) {
		if (!LightGroups[Group].lights || !LightGroups[Group].lights?.length) {
			this.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const simpleLights = await this.getSimpleLightsAsync(LightGroups[Group].lights, OnOff);
		const useBrightness = await this.getUseBrightnessLightsAsync(LightGroups[Group].lights, OnOff, Group);
		await Promise.all([useBrightness, simpleLights]);

		return true;
	}

	/**
	 * Get simple lights with no brightness state
	 * @async
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async getSimpleLightsAsync(Lights, OnOff) {
		const promises = Lights.filter((Light) => Light.power?.oid && !Light.bri?.oid).map((Light) => {
			this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
		});

		return promises;
	}

	/**
	 * Get lights with brightness state and useBri=true
	 * @async
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 * @param {object} Group
	 */
	async getUseBrightnessLightsAsync(Lights, OnOff, Group) {
		const promises = Lights.filter((Light) => Light?.bri?.oid && Light?.bri?.useBri).map((Light) => {
			return this.SetDeviceBriAsync(
				Light,
				OnOff ? (LightGroups[Group].adaptiveBri ? this.AdaptiveBri(Group) : LightGroups[Group].setBri) : 0,
			);
		});

		return promises;
	}

	/**
	 * DeviceSwitch lights before ramping (if brightness state available and not use Bri for ramping or transition time)
	 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async DeviceSwitchForRampingAsync(Group, OnOff) {
		this.writeLog(`[ DeviceSwitchForRamping ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

		const promises = LightGroups[Group].lights
			.filter((Light) => Light?.bri?.oid && !Light?.bri?.useBri && Light?.power?.oid && Light?.tt?.oid)
			.map((Light) => {
				this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
			});
		await Promise.all(promises).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "DeviceSwitchForRampingAsync");
			return;
		});
		return true;
	}

	/**
	 * BrightnessDevicesSwitchPower
	 * @description Switch lights before ramping (if brightness state available and not useBri for ramping or transition time)
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async BrightnessDevicesSwitchPowerAsync(Lights, OnOff) {
		return Lights.filter((Light) => Light.power?.oid && Light.bri?.oid && !Light.bri?.useBri && !Light.tt?.oid).map(
			(Light) => {
				this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
			},
		);
	}

	/**
	 * BrightnessDevicesWithTransitionTimeAsync
	 * @description Set Brighness to Lights with transission time
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} Brightness Brightness to set
	 */
	async BrightnessDevicesWithTransitionTimeAsync(Lights, Brightness) {
		const promises = Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && Light.tt?.oid).map((Light) => {
			this.setForeignStateAsync(Light.bri.oid, Brightness);
		});
		return promises;
	}

	/**
	 * Timeout for transition ending
	 * @async
	 * @param {string} Group
	 * @param {number} seconds time in seconds

	 */
	async waitForTransitionAsync(Group, seconds) {
		if (this.TransitionTimeoutObject[Group]) {
			this.clearTimeout(this.TransitionTimeoutObject[Group].timeout);
		}

		return new Promise((resolve) => {
			this.TransitionTimeoutObject[Group] = {};

			this.TransitionTimeoutObject[Group].timeout = this.setTimeout(() => {
				this.writeLog(`[ waitForTransitionAsync ] Timeout of Group="${Group}" in ${seconds}s end`);
				resolve(true);
			}, seconds * 1000);

			this.TransitionTimeoutObject[Group].abort = () => {
				this.clearTimeout(this.TransitionTimeoutObject[Group].timeout);
				this.writeLog(`[ waitForTransitionAsync ] Timeout of Group="${Group}" aborted`);
				resolve(false);
			};
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
		const Lights = LightGroups[Group]?.lights || [];
		if (!this.config?.RampSteps) {
			this.writeLog(
				`[ RampWithInterval ] No RampSteps defined. Please check your config! We use 10 steps as default!`,
				"warn",
			);
		}
		const RampSteps = this.config.RampSteps || 10;
		const RampTime = helper.limitNumber(LightGroups[Group].rampOn?.time, 5);
		const brightness = LightGroups[Group].adaptiveBri ? this.AdaptiveBri(Group) : LightGroups[Group].setBri;

		if (LightGroups[Group].rampOn?.time < 5) {
			this.writeLog(
				`[ RampWithInterval ] Ramp time is lower than 5s. We use minimum 5s as default for ramping`,
				"warn",
			);
		}
		let LoopCount = 0;

		const rampStepDuration = Math.round(RampTime / RampSteps) * 1000;

		const rampStepFunction = async () => {
			LoopCount++;
			const bri = rampUp
				? Math.round(RampSteps * LoopCount * (brightness / 100))
				: brightness - brightness / RampSteps - Math.round(RampSteps * LoopCount * (brightness / 100));

			const promises = Lights.filter((Light) => Light.bri?.oid && Light.bri?.useBri && !Light.tt?.oid).map(
				(Light) => this.setForeignStateAsync(Light.bri.oid, bri),
			);
			await Promise.all(promises);

			if (LoopCount < RampSteps) {
				this.RampTimeoutObject[Group] = setTimeout(rampStepFunction, rampStepDuration);
			} else {
				await this.clearRampTimeoutsAsync(Group);
			}
		};

		this.RampTimeoutObject[Group] = setTimeout(rampStepFunction, rampStepDuration);
	}

	/**
	 * TurnOnWithRamping
	 * @async
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async TurnOnWithRampingAsync(Group) {
		const funcName = "TurnOnWithRampingAsync";
		const brightness = LightGroups[Group].adaptiveBri ? this.AdaptiveBri(Group) : LightGroups[Group].setBri;
		//
		// ******* Anschalten mit ramping * //
		//
		if (LightGroups[Group]?.ramping !== "up") {
			LightGroups[Group].ramping = "up";
			await Promise.all([this.clearRampTimeoutsAsync(Group), this.clearTransitionTimeoutAsync(Group)]);

			if (LightGroups[Group].rampOn?.switchOutletsLast) {
				this.writeLog(`[ ${funcName} ] Switch on with ramping and simple lamps last for Group="${Group}"`);

				await this.BrightnessDevicesSwitchPowerAsync(LightGroups[Group].lights, true); // Turn on lights for ramping is no use Bri is used
				await this.SetTtAsync(Group, LightGroups[Group].rampOn.time * 1000, "ramping");

				const promises = [
					this.RampWithIntervalAsync(Group, true),
					this.BrightnessDevicesWithTransitionTimeAsync(LightGroups[Group].lights, brightness),
					this.waitForTransitionAsync(Group, LightGroups[Group].rampOn.time),
				];

				const results = await Promise.all(promises).catch((error) =>
					this.writeLog(
						`Error: ${error.message}, Stack: ${error.stack}`,
						"TurnOnWithRampingAsync / Promises",
						"error",
					),
				);
				const waitForTransitionResult = results[2];

				if (!waitForTransitionResult) {
					return;
				} else {
					await Promise.all([
						this.getSimpleLightsAsync(LightGroups[Group].lights, true),
						this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff"),
					]);

					return true;
				}
			} else if (LightGroups[Group].rampOn?.enabled && !LightGroups[Group].rampOn?.switchOutletsLast) {
				//Anschalten mit Ramping und einfache Lampen zuerst

				this.writeLog(`[ ${funcName} ] Anschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

				await Promise.all([
					this.getSimpleLightsAsync(LightGroups[Group].lights, true),
					this.DeviceSwitchForRampingAsync(Group, true),
				]);

				await this.SetTtAsync(Group, LightGroups[Group].rampOn.time * 1000, "ramping");

				const promises = [
					this.RampWithIntervalAsync(Group, true),
					this.BrightnessDevicesWithTransitionTimeAsync(LightGroups[Group].lights, brightness),
					this.waitForTransitionAsync(Group, LightGroups[Group].rampOn.time),
				];

				const results = await Promise.all(promises).catch((error) =>
					this.writeLog(
						`Error: ${error.message}, Stack: ${error.stack}`,
						"TurnOnWithRampingAsync / Promises",
						"error",
					),
				);
				const waitForTransitionResult = results[2];

				if (!waitForTransitionResult) {
					return;
				} else {
					this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff");
					return true;
				}
			}
		}
	}

	/**
	 * TurnOffWithRamping
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async TurnOffWithRampingAsync(Group) {
		const funcName = "TurnOffWithRampingAsync";
		//
		//******* Ausschalten mit Ramping */
		//
		if (LightGroups[Group]?.ramping !== "down") {
			LightGroups[Group].ramping = "down";
			await Promise.all([this.clearRampTimeoutsAsync(Group), this.clearTransitionTimeoutAsync(Group)]);
			if (LightGroups[Group].rampOff.enabled && LightGroups[Group].rampOff.switchOutletsLast) {
				////Ausschalten mit Ramping und einfache Lampen zuletzt

				this.writeLog(`[ ${funcName} ] Switch on with ramping and simple lamps last for Group="${Group}"`);

				const promises = [
					this.RampWithIntervalAsync(Group, false),
					this.BrightnessDevicesWithTransitionTimeAsync(LightGroups[Group].lights, 0),
					this.waitForTransitionAsync(Group, LightGroups[Group].rampOff.time),
				];

				await this.SetTtAsync(Group, LightGroups[Group].rampOff.time, "ramping");
				const results = await Promise.all(promises).catch((error) =>
					this.writeLog(
						`Error: ${error.message}, Stack: ${error.stack}`,
						"TurnOffWithRampingAsync / Promises",
						"error",
					),
				);
				const waitForTransitionResult = results[2];

				if (!waitForTransitionResult) {
					return;
				} else {
					await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff");

					await Promise.all([
						this.getSimpleLightsAsync(LightGroups[Group].lights, false),
						this.DeviceSwitchForRampingAsync(Group, false),
					]);

					return true;
				}
			} else if (LightGroups[Group].rampOff.enabled && !LightGroups[Group].rampOff.switchOutletsLast) {
				////Ausschalten mit Ramping und einfache Lampen zuerst

				this.writeLog(
					`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`,
				);

				await Promise.all([
					this.getSimpleLightsAsync(LightGroups[Group].lights, false),
					this.SetTtAsync(Group, LightGroups[Group].rampOff.time, "ramping"),
				]);

				const promises = [
					this.RampWithIntervalAsync(Group, false),
					this.BrightnessDevicesWithTransitionTimeAsync(LightGroups[Group].lights, 0),
					this.waitForTransitionAsync(Group, LightGroups[Group].rampOff.time),
				];

				const results = await Promise.all(promises).catch((error) =>
					this.writeLog(
						`Error: ${error.message}, Stack: ${error.stack}`,
						"TurnOffWithRampingAsync / Promises",
						"error",
					),
				);
				const waitForTransitionResult = results[2];

				if (!waitForTransitionResult) {
					return;
				} else {
					await this.SetTtAsync(Group, LightGroups[Group].transitionTime, "OnOff");
					await this.DeviceSwitchForRampingAsync(Group, false);
				}
			}
		}
	}

	/**
	 * GroupPowerCleaningLightOnOff
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async GroupPowerCleaningLightOnOffAsync(Group, OnOff) {
		const funcName = "GroupPowerCleaningLightOnOffAsync";
		this.writeLog(`Reaching GroupPowerCleaningLightOnOff for Group="${Group}, OnOff="${OnOff}"`, "debug", funcName);

		await this.clearAutoOffTimeoutsAsync(Group);

		if (OnOff) {
			if (LightGroups[Group].power) {
				await Promise.all([
					this.SetBrightnessAsync(Group, 100),
					this.SetCtAsync(Group, this.config.maxCt ?? 6700),
				]);
				LightGroups[Group].lastPower = true;
			} else {
				LightGroups[Group].power = true;
				LightGroups[Group].lastPower = false;
				await this.SimpleGroupPowerOnOffAsync(Group, true);
				await Promise.all([
					this.SetBrightnessAsync(Group, 100),
					this.SetCtAsync(Group, this.config.maxCt || 6700),
					this.setStateAsync(`${Group}.power`, { val: true, ack: true }),
				]);
			}
		} else {
			const brightness = LightGroups[Group].adaptiveBri ? this.AdaptiveBri(Group) : LightGroups[Group].bri;

			await Promise.all([
				this.SetBrightnessAsync(Group, brightness),
				this.SetCtAsync(Group, LightGroups[Group].ct),
			]);

			if (!LightGroups[Group].lastPower) {
				LightGroups[Group].power = false;
				await Promise.all([
					this.SimpleGroupPowerOnOffAsync(Group, false),
					this.setStateAsync(`${Group}.power`, { val: false, ack: true }),
				]);
			}
		}

		await this.setStateAsync(`${Group}.powerCleaningLight`, { val: OnOff, ack: true });
	}

	/**
	 * AutoOnLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOnLuxAsync(Group) {
		if (
			!LightGroups[Group]?.autoOnLux ||
			!LightGroups[Group]?.autoOnLux?.enabled ||
			!LightGroups[Group]?.autoOnLux?.minLux ||
			!LightGroups[Group]?.autoOnLux?.dailyLock ||
			!LightGroups[Group]?.autoOnLux?.switchOnlyWhenPresence
		) {
			this.writeLog(
				`[ AutoOnLuxAsync ] Not able to auto on for Group: "${Group}". Please check your config! Aborted`,
			);
			return;
		}
		this.writeLog(
			`[ AutoOnLuxAsync ] Group="${Group} enabled="${LightGroups[Group].autoOnLux.enabled}", actuallux="${LightGroups[Group].actualLux}", minLux="${LightGroups[Group].autoOnLux.minLux}" LightGroups[Group].autoOnLux.dailyLock="${LightGroups[Group].autoOnLux.dailyLock}"`,
		);

		LightGroups[Group].setBri = LightGroups[Group].autoOnLux.bri || LightGroups[Group].bri;
		LightGroups[Group].setColor = LightGroups[Group].autoOnLux.color || LightGroups[Group].color;

		if (LightGroups[Group].autoOnLux?.operator === "<") {
			if (
				LightGroups[Group].autoOnLux?.enabled &&
				!LightGroups[Group].power &&
				!LightGroups[Group].autoOnLux?.dailyLock &&
				LightGroups[Group].actualLux <= LightGroups[Group].autoOnLux?.minLux
			) {
				this.writeLog(`[ AutoOnLuxAsync ] activated Group="${Group}"`, "info");

				if (
					(LightGroups[Group].autoOnLux?.switchOnlyWhenPresence && this.ActualPresence) ||
					(LightGroups[Group].autoOnLux?.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOffAsync(Group, true);
					await this.SetWhiteSubstituteColorAsync(Group);
					await this.PowerOnAftercareAsync(Group);
				}

				LightGroups[Group].autoOnLux.dailyLock = true;

				await this.setStateAsync(`${Group}.autoOnLux.dailyLock`, { val: true, ack: true });
			} else if (
				LightGroups[Group].autoOnLux?.dailyLock &&
				LightGroups[Group].actualLux > LightGroups[Group].autoOnLux?.minLux
			) {
				//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux?.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await this.setStateAsync(`${Group}.autoOnLux.dailyLock`, { val: false, ack: true });
					this.writeLog(
						`Setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`,
						"info",
						"AutoOnLuxAsync",
					);
				}
			}
		} else if (LightGroups[Group].autoOnLux.operator === ">") {
			if (
				LightGroups[Group].autoOnLux?.enabled &&
				!LightGroups[Group].power &&
				!LightGroups[Group].autoOnLux?.dailyLock &&
				LightGroups[Group].actualLux >= LightGroups[Group].autoOnLux?.minLux
			) {
				this.writeLog(`activated Group="${Group}"`, "info", "AutoOnLuxAsync");

				if (
					(LightGroups[Group].autoOnLux.switchOnlyWhenPresence && this.ActualPresence) ||
					(LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOffAsync(Group, true);

					await this.SetWhiteSubstituteColorAsync(Group);

					await this.PowerOnAftercareAsync(Group);
				}

				LightGroups[Group].autoOnLux.dailyLock = true;
				await this.setStateAsync(`${Group}.autoOnLux.dailyLock`, { val: true, ack: true });
			} else if (
				LightGroups[Group].autoOnLux.dailyLock &&
				LightGroups[Group].actualLux < LightGroups[Group].autoOnLux.minLux
			) {
				//DailyLock zurücksetzen

				LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (LightGroups[Group].autoOnLux.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					LightGroups[Group].autoOnLux.dailyLock = false;
					await this.setStateAsync(`${Group}.autoOnLux.dailyLock`, { val: false, ack: true });
					this.writeLog(
						`Setting DailyLock to ${LightGroups[Group].autoOnLux.dailyLock}`,
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
		if (!LightGroups[Group].isMotion) {
			return;
		}
		if (
			LightGroups[Group].autoOnMotion.enabled === undefined ||
			LightGroups[Group].autoOnMotion.minLux === undefined ||
			LightGroups[Group].autoOnMotion.bri === undefined ||
			LightGroups[Group].autoOnMotion.color === undefined
		) {
			this.writeLog(
				`[ AutoOnMotionAsync ] Not able to auto on for Group: "${Group}". Please check your config! Aborted`,
				"error",
			);
			return;
		}

		await this.clearAutoOffTimeoutsAsync(Group);

		LightGroups[Group].setBri = LightGroups[Group].autoOnMotion.bri || LightGroups[Group].bri;
		LightGroups[Group].setColor = LightGroups[Group].autoOnMotion.color || LightGroups[Group].color;

		const { autoOnMotion, actualLux, isMotion, power } = LightGroups[Group] || {};

		if (autoOnMotion?.enabled && actualLux < autoOnMotion?.minLux && isMotion && !power) {
			this.writeLog(`Motion for Group="${Group}" detected, switching on`, "info");
			await this.GroupPowerOnOffAsync(Group, true);

			await this.SetWhiteSubstituteColorAsync(Group);

			await this.PowerOnAftercareAsync(Group);
		}

		return true;
	}

	/**
	 * AutoOnPresenceIncrease
	 */
	async AutoOnPresenceIncreaseAsync() {
		this.writeLog(`[ AutoOnPresenceIncreaseAsync ] Reaching`);

		const groupKeys = Object.keys(LightGroups);

		for (const Group of groupKeys) {
			if (["All", "info"].includes(Group)) continue;

			if (
				LightGroups[Group].autoOnPresenceIncrease.enabled &&
				LightGroups[Group].actualLux < LightGroups[Group].autoOnPresenceIncrease.minLux &&
				!LightGroups[Group].power
			) {
				LightGroups[Group].setBri = LightGroups[Group].autoOnPresenceIncrease.bri || LightGroups[Group].bri;
				LightGroups[Group].setColor =
					LightGroups[Group].autoOnPresenceIncrease.color || LightGroups[Group].color;
				await this.GroupPowerOnOffAsync(Group, true);

				await this.SetWhiteSubstituteColorAsync(Group);

				await this.PowerOnAftercareAsync(Group);
			}
		}
	}

	/**
	 * Blink
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async BlinkAsync(Group) {
		this.setStateAsync(`${Group}.blink.enabled`, { val: true, ack: true });

		let loopcount = 0;

		//Save actual power state
		await this.SetValueToObjectAsync(Group, "blink.actual_power", LightGroups[Group].power);

		if (!LightGroups[Group].power) {
			//Wenn Gruppe aus, anschalten und ggfs. Helligkeit und Farbe setzen

			this.writeLog(`[ Blink ] on ${loopcount}`, "info");

			for (const Light of LightGroups[Group].lights) {
				if (!Light?.power?.oid && !Light?.bri?.oid) {
					this.writeLog(
						`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
						"warn",
					);
				} else if (Light?.bri?.useBri && Light?.bri?.oid) {
					await this.setForeignStateAsync(Light.bri.oid, LightGroups[Group].blink.bri, false);
					this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
				} else if (Light?.power?.oid) {
					await this.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
					this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
					if (Light?.bri?.oid && LightGroups[Group].blink.bri !== 0)
						await this.SetDeviceBriAsync(Light, LightGroups[Group].blink.bri);
				}
			}

			LightGroups[Group].power = true;
			await this.setStateAsync(`${Group}.power`, { val: true, ack: true });

			await this.SetWhiteSubstituteColorAsync(Group);

			if (LightGroups[Group].blink.color != "") await this.SetColorAsync(Group, LightGroups[Group].blink.color);

			loopcount++;
		}

		await this.clearBlinkIntervalsAsync(Group);

		this.BlinkIntervalObj[Group] = setInterval(async () => {
			loopcount++;

			this.writeLog(`[ Blink ] Is Infinite: ${LightGroups[Group].blink.infinite}`);
			this.writeLog(`[ Blink ] Stop: ${LightGroups[Group].blink.stop || false}`);

			if (
				(loopcount <= LightGroups[Group].blink.blinks * 2 || LightGroups[Group].blink.infinite) &&
				!LightGroups[Group].blink.stop
			) {
				if (LightGroups[Group].power) {
					this.writeLog(`[ Blink ] off ${loopcount}`, "info");

					for (const Light of LightGroups[Group].lights) {
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

					if (LightGroups[Group].blink.color != "")
						await this.SetColorAsync(Group, LightGroups[Group].blink.color);

					LightGroups[Group].power = false;
					this.setStateAsync(`${Group}.power`, { val: false, ack: true });
					//this.SetLightState();
				} else {
					this.writeLog(`[ Blink ] => on ${loopcount}`, "info");

					for (const Light of LightGroups[Group].lights) {
						if (!Light?.power?.oid && !Light?.bri?.oid) {
							this.writeLog(
								`[ Blink ] Can't switch on. No power or brightness state defined for Light = "${Light.description}" in Group = "${Group}"`,
								"warn",
							);
						} else if (Light?.bri?.useBri && Light?.bri?.oid) {
							await this.setForeignStateAsync(Light.bri.oid, LightGroups[Group].blink.bri, false);
							this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.bri.oid} to: on`);
						} else if (Light?.power?.oid) {
							await this.setForeignStateAsync(Light.power.oid, Light.power.onVal, false);
							this.writeLog(`[ Blink ] Switching ${Light.description} ${Light.power.oid} to: on`);
						}
					}

					LightGroups[Group].power = true;
					this.setStateAsync(`${Group}.power`, { val: true, ack: true });
					//this.SetLightState();
				}
			} else {
				await this.clearBlinkIntervalsAsync(Group);
				this.setStateAsync(`${Group}.blink.enabled`, { val: false, ack: true });
				if (LightGroups[Group].blink.infinite || LightGroups[Group].blink.actual_power) {
					await this.setStateAsync(`${Group}.power`, {
						val: LightGroups[Group].blink.actual_power,
						ack: false,
					});
					await this.SetColorAsync(Group, LightGroups[Group].color);
				}
			}
		}, LightGroups[Group].blink.frequency * 1000);
	}

	/**
	 * AutoOffLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOffLuxAsync(Group) {
		//Handling für AutoOffLux

		this.writeLog(`[ AutoOffLux ] Reaching for Group="${Group}"`);

		if (
			LightGroups[Group].autoOffLux?.operator === "<" &&
			LightGroups[Group].actualLux < LightGroups[Group].autoOffLux?.minLux &&
			LightGroups[Group].autoOffLux?.enabled &&
			LightGroups[Group].power &&
			!LightGroups[Group].autoOffLux?.dailyLock
		) {
			await this.GroupPowerOnOffAsync(Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await this.setStateAsync(`${Group}.autoOffLux.dailyLock`, { val: true, ack: true });
		} else if (
			LightGroups[Group].autoOffLux?.operator === ">" &&
			LightGroups[Group].actualLux > LightGroups[Group].autoOffLux?.minLux &&
			LightGroups[Group].autoOffLux?.enabled &&
			LightGroups[Group].power &&
			!LightGroups[Group].autoOffLux?.dailyLock
		) {
			await this.GroupPowerOnOffAsync(Group, false);
			LightGroups[Group].autoOffLux.dailyLock = true;
			await this.setStateAsync(`${Group}.autoOffLux.dailyLock`, { val: true, ack: true });
		}

		if (LightGroups[Group].autoOffLux?.operator === "<") {
			//DailyLock resetten

			if (
				LightGroups[Group].actualLux > LightGroups[Group].autoOffLux?.minLux &&
				LightGroups[Group].autoOffLux?.dailyLock
			) {
				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux?.dailyLockCounter >= 5) {
					LightGroups[Group].autoOffLux.dailyLock = false;
					await this.setStateAsync(`${Group}.autoOffLux.dailyLock`, { val: false, ack: true });
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		} else if (LightGroups[Group].autoOffLux?.operator === ">") {
			if (
				LightGroups[Group].actualLux < LightGroups[Group].autoOffLux?.minLux &&
				LightGroups[Group].autoOffLux.dailyLock
			) {
				LightGroups[Group].autoOffLux.dailyLockCounter++;

				if (LightGroups[Group].autoOffLux?.dailyLockCounter >= 5) {
					LightGroups[Group].autoOffLux.dailyLock = false;
					await this.setStateAsync(`${Group}.autoOffLux.dailyLock`, { val: false, ack: true });
					LightGroups[Group].autoOffLux.dailyLockCounter = 0;
				}
			}
		}
	}

	/**
	 * AutoOffTimed
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @returns {Promise<void>}
	 */
	async AutoOffTimedAsync(Group) {
		if (this.AutoOffTimeoutObject[Group] !== null) {
			this.writeLog("No start of autoOff because it's already running");
			return;
		}

		await this.clearAutoOffTimeoutsAsync(Group);

		const { enabled, noAutoOffWhenMotion, autoOffTime, noticeTime, noticeBri, noticeEnabled } =
			LightGroups[Group].autoOffTimed;
		const { power, isMotion, powerCleaningLight } = LightGroups[Group];

		if (!enabled || (noAutoOffWhenMotion && isMotion) || powerCleaningLight || !power) {
			return;
		}

		this.writeLog(`Start autoOff timeout for Group="${Group} with ${autoOffTime} seconds"`, "info");

		const countdownStep = async (countdownValue) => {
			await this.setStateAsync(`${Group}.autoOffTimed.countdown`, { val: countdownValue, ack: true });

			if (countdownValue > 0) {
				countdownValue--;

				if (noticeEnabled && noticeTime > autoOffTime && countdownValue === noticeTime) {
					this.SetBrightnessAsync(Group, noticeBri, "autoOff");
				}
				this.AutoOffTimeoutObject[Group] = this.setTimeout(countdownStep, 1000, countdownValue);
			} else {
				await this.clearAutoOffTimeoutsAsync(Group);
				await this.setStateAsync(`${Group}.power`, { val: false, ack: false });
				return;
			}
		};

		countdownStep(autoOffTime);
	}

	/**
	 * SetMasterPower
	 * @param {*} value value of state
	 */
	async SetMasterPowerAsync(value) {
		const promises = Object.keys(LightGroups)
			.filter((Group) => !["All", "info"].includes(Group))
			.map((Group) => {
				return this.setStateAsync(`${Group}.power`, { val: value, ack: false });
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(`Not able to set master power. Error: ${error}`, "error", "SetMasterPowerAsync");
			return;
		});

		return Promise.resolve(true);
	}
	// *********************************************
	// *                                           *
	// *            LIGHT HANDLING                 *
	// *                                           *
	// *********************************************

	/**
	 * AdaptiveBri
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	AdaptiveBri(Group) {
		this.writeLog(
			`[ AdaptiveBriAsync ] Group="${Group}" actual Lux="${LightGroups[Group].actualLux}" generic lux="${this.ActualGenericLux}`,
		);

		let TempBri = 0;
		const minBri = typeof this.config.minBri === "string" ? parseInt(this.config.minBri) : this.config.minBri;

		if (LightGroups[Group].adaptiveBri) {
			if (LightGroups[Group].actualLux === 0) {
				TempBri = minBri;
			} else if (LightGroups[Group].actualLux >= 10000) {
				TempBri = 100;
			} else if (LightGroups[Group].actualLux > 0 && LightGroups[Group].actualLux < 10000) {
				TempBri = LightGroups[Group].actualLux / 100;

				if (TempBri < this.config.minBri) TempBri = minBri;
			}
		}
		return Math.round(TempBri);
	}

	/**
	 * SetBrightness
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} Brightness Value 0 to 100
	 * @param {string} [caller="default"] - Quelle des Funktionsaufrufs. Standardmäßig "default". Nur bei default wird ack=true gesetzt
	 */
	async SetBrightnessAsync(Group, Brightness, caller = "default") {
		this.writeLog(
			`[ SetBrightness ] Reaching for Group="${Group}", Brightness="${Brightness}, PowerState="${LightGroups[Group].power}"`,
		);
		if (!LightGroups[Group]?.lights?.length) {
			this.writeLog(
				`[ SetBrightness ] Not able to set Brighness for Group = "${Group}". No lights are defined or group not defined!!`,
				"warn",
			);
			return;
		}

		//Set Brightness only if Group Power on
		if (LightGroups[Group].power) {
			const promises = LightGroups[Group].lights
				.filter((Light) => Light?.bri?.oid)
				.map((Light) => this.SetDeviceBriAsync(Light, Brightness));

			await Promise.all(promises).catch((error) => {
				this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetBrightnessAsync");
				return;
			});
		}

		if (caller === "default") await this.setStateAsync(`${Group}.bri`, { val: Brightness, ack: true });
		return true;
	}

	/**
	 * Sets the brightness of a device based on the given `Brightness` parameter and the `minVal` and `maxVal` values from the `Light` object.
	 * @param {object} Light - The Light object containing the device information, including the `minVal` and `maxVal` values for the brightness.
	 * @param {number | undefined} brightness - The brightness value to be set on the device.
	 * @returns {Promise<boolean>} - Returns a Promise that resolves to `true` if the brightness was successfully set, or `false` if there was an error.
	 */
	async SetDeviceBriAsync(Light, brightness) {
		const { bri } = Light ?? {};
		if (!bri?.oid) {
			return false;
		}
		const log = !bri?.useBri
			? `[ SetDeviceBriAsync ] Switching with Power State is activated. Min. Brightness is defined with 2%. Actual Brightness = "${brightness}"`
			: `[ SetDeviceBriAsync ] Switching with Brightness is activated. No min. Brightness needed. Actual Brightness = "${brightness}"`;
		this.writeLog(log);

		const minBrightness = bri?.useBri ? 0 : 2;
		brightness = Math.round(Math.min(Math.max(brightness || 0, minBrightness), 100));

		const minVal = bri?.minVal ?? 0;
		const maxVal = bri?.maxVal ?? 100;
		const defaultBri = bri?.defaultBri ?? 100;

		const value = Math.round((brightness / 100) * (maxVal - minVal) + minVal);

		await this.setForeignStateAsync(Light.bri.oid, Math.round((value / maxVal) * defaultBri), false).catch(
			(error) => {
				this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetDeviceBriAsync");
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
	async SetCtAsync(Group, ct = LightGroups[Group].ct) {
		if (!LightGroups[Group].lights?.length) {
			this.writeLog(
				`[ SetCt ] Not able to set Color-Temperature for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const ctValue = ct ?? LightGroups[Group].ct;

		this.writeLog(`[ SetCt ] Reaching for Group="${Group}" Ct="${ctValue}"`);

		await Promise.all(
			LightGroups[Group].lights.map((Light) => {
				const { ct } = Light ?? {};
				if ((LightGroups[Group].power || ct?.sendCt) && ct?.oid) {
					const oid = ct?.oid;
					const outMinVal = ct?.minVal || 0;
					const outMaxVal = ct?.maxVal || 100;
					const minKelvin = ct?.minKelvin || 2700;
					const maxKelvin = ct?.maxKelvin || 6500;
					const ctConversion = ct?.ctConversion ?? "default";
					const value = helper.KelvinToRange(
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
						this.setForeignStateAsync(oid, value, false);
					}
				}
			}),
		).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetCtAsync");
			return;
		});

		await this.setStateAsync(`${Group}.ct`, { val: ctValue, ack: true });

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

		if (sunsetDate instanceof Date && sunriseDate instanceof Date && solarNoonDate instanceof Date) {
			sunset = sunsetDate.getTime(); //Sonnenuntergang
			sunrise = sunriseDate.getTime(); //Sonnenaufgang
			solarNoon = solarNoonDate.getTime(); //Höchster Sonnenstand (Mittag)
		} else {
			this.writeLog(`[ AdaptiveCtAsync ] sunsetDate, sunriseDate or solarNoonDate are no Date Objects"`, "warn");
			return;
		}

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

		for (const Group in LightGroups) {
			if (["All", "info"].includes(Group)) continue;

			const LightGroup = LightGroups[Group];
			const adaptiveCtMode = LightGroup.adaptiveCtMode;
			const adaptiveCtEnabled = LightGroup.adaptiveCt?.enabled;
			const currentCt = LightGroup.ct;

			if (adaptiveCtEnabled) {
				let newCtValue;

				switch (adaptiveCtMode) {
					case "linear":
						newCtValue = adaptiveCtLinear;
						break;

					case "solar":
						newCtValue = adaptiveCtSolar;
						break;
					case "solarInterpolated":
						newCtValue = adaptiveCtSolarInterpolated;
						break;
					case "timed":
						morningTime = getDateObject(LightGroups[Group].adaptiveCt?.adaptiveCtTime).getTime();
						if (ActualTime >= morningTime && ActualTime <= sunset) {
							adaptiveCtTimed = Math.round(
								maxCt + ((minCt - maxCt) * (ActualTime - morningTime)) / (sunset - morningTime),
							);
						} else {
							adaptiveCtTimed = minCt;
						}

						newCtValue = adaptiveCtTimed;
						break;
					case "timedInterpolated":
						morningTime = getDateObject(LightGroups[Group].adaptiveCt?.adaptiveCtTime).getTime();

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
						newCtValue = adaptiveCtTimedInterpolated;
						break;
					default:
						newCtValue = currentCt;
						break;
				}

				if (currentCt !== newCtValue) {
					await this.setStateAsync(`${Group}.ct`, { val: newCtValue, ack: false });
				}
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
		if (!LightGroups[Group] || !LightGroups[Group].lights || !LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetWhiteSubstituteColorAsync ] Not able to set white substitute color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const minCt = this.config.minCt ?? 2000;
		const maxCt = this.config.maxCt ?? 6700;

		this.writeLog(
			`[ SetWhiteSubstituteColorAsync ] Reaching for Group="${Group}" = "${LightGroups[Group].description}" LightGroups[Group].power="${LightGroups[Group].power}" LightGroups[Group].color="${LightGroups[Group].color}`,
			"info",
		);

		//Nur ausführen bei anschalten und Farbe weiß

		const promisesWarmWhiteDayLight = LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light?.color?.warmWhiteColor &&
					Light?.color?.dayLightColor &&
					Light.color?.setCtwithColor &&
					!Light.color?.type?.hue &&
					!Light.sat?.oid &&
					LightGroups[Group].color.toUpperCase() == "#FFFFFF" &&
					(LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map((Light) => {
				const colorValue =
					LightGroups[Group].ct < (maxCt - minCt) / 4 + minCt
						? Light.color.warmWhiteColor
						: Light.color.dayLightColor;
				this.setForeignStateAsync(Light.color.oid, colorValue, false);
			});

		const promisesKelvinWithHUE = LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.hue &&
					Light.bri?.oid &&
					Light.sat?.oid &&
					(LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map(async (Light) => {
				const colorValue = converters.ConvertKelvinToHue(LightGroups[Group].ct);
				await Promise.all([
					this.setForeignStateAsync(Light.color.oid, colorValue.hue, false),
					this.setForeignStateAsync(Light.sat.oid, colorValue.saturation, false),
					this.setForeignStateAsync(Light.bri.oid, colorValue.brightness, false),
				]);
			});

		const promisesKelvinWithRGB = LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.rgb &&
					(LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map((Light) => {
				const colorValue = converters.convertKelvinToRGB(LightGroups[Group].ct);
				this.setForeignStateAsync(Light.color.oid, { val: JSON.stringify(colorValue), ack: false });
			});

		const promisesKelvinWithXY = LightGroups[Group].lights
			.filter(
				(Light) =>
					!Light?.ct?.oid &&
					Light?.color?.oid &&
					Light.color?.setCtwithColor &&
					Light.color?.type?.xy &&
					(LightGroups[Group].power || Light?.color?.sendColor),
			)
			.map((Light) => {
				const rgb = converters.convertKelvinToRGB(LightGroups[Group].ct);
				const colorValue = converters.ConvertRgbToXy(rgb);
				this.setForeignStateAsync(Light.color.oid, { val: JSON.stringify(colorValue), ack: false });
			});

		await Promise.all([
			promisesWarmWhiteDayLight,
			promisesKelvinWithHUE,
			promisesKelvinWithRGB,
			promisesKelvinWithXY,
		]).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetWhiteSubstituteColorAsync");
		});
	}

	/**
	 * SetColorMode
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async SetColorModeAsync(Group) {
		if (!LightGroups[Group] || !LightGroups[Group].lights || !LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetColorModeAsync ] Not able to set color mode for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const promises = LightGroups[Group].lights
			.filter(
				(Light) =>
					Light.modeswitch &&
					(LightGroups[Group].power || Light?.modeswitch?.sendModeswitch) &&
					Light?.modeswitch?.oid,
			) // Prüfen, ob der Datenpunkt vorhanden ist und die Bedingungen erfüllt sind
			.map(async (Light) => {
				if (LightGroups[Group].color.toUpperCase() == "#FFFFFF") {
					// bei Farbe weiss
					await Promise.all([
						this.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.whiteModeVal, false),
						this.writeLog(`[ SetColorModeAsync ] id="${Light.modeswitch.oid}" to whiteMode`),
					]);
				} else {
					// bei allen anderen Farben
					await Promise.all([
						this.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.colorModeVal, false),
						this.writeLog(`[ SetColorModeAsync ] id="${Light.modeswitch.oid}" to colorMode`),
					]);
				}
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetColorModeAsync");
		});

		return true;
	}

	/**
	 * SetColor
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {any} Color
	 */
	async SetColorAsync(Group, Color) {
		if (!LightGroups[Group] || !LightGroups[Group].lights || !LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetColorAsync ] Not able to set color for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(
			`[ SetColorAsync ] Reaching for Group="${Group}" power="${LightGroups[Group].power}" Color="${Color}"`,
			"info",
		);

		const promises = LightGroups[Group].lights
			.filter((Light) => Light.color && (LightGroups[Group].power || Light?.color?.sendColor))
			.map(async (Light) => {
				if (Light?.color?.oid) {
					// Prüfen ob Datenpunkt für Color vorhanden
					switch (Light.color.colorType) {
						case "hex":
							this.setForeignStateAsync(Light.color.oid, Color, false);
							break;
						case "rgb": {
							const rgbTemp = converters.ConvertHexToRgb(Color);
							this.setForeignStateAsync(Light.color.oid, {
								val: JSON.stringify(rgbTemp),
								ack: false,
							});
							break;
						}
						case "xy": {
							const rgbTemp = converters.ConvertHexToRgb(Color);
							const XyTemp = converters.ConvertRgbToXy(rgbTemp);
							this.setForeignStateAsync(Light.color.oid, {
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
								this.writeLog(
									`[ SetColorAsync ] Set color with HUE is not possible, because brightness or saturation state is not defined!`,
									"warn",
								);
							}
							break;
						}
						default:
							this.writeLog(
								`[ SetColorAsync ] Unknown colorType = "${Light.color.colorType}" in Group="${Group}", please specify!`,
								"warn",
							);
					}
				}
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetColorAsync");
		});

		await this.setStateAsync(`${Group}.color`, { val: LightGroups[Group].color, ack: true });
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
	async SetTtAsync(Group, RampTime, prop = "default") {
		if (!LightGroups[Group].lights || !LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SetTtAsync ] Not able to set transition time for Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}
		this.writeLog(`[ SetTtAsync ] Reaching for Group="${Group}", TransitionTime="${RampTime}s"`);

		const promises = LightGroups[Group].lights
			.filter((Light) => Light.tt?.oid)
			.map(async (Light) => {
				const tt = convertTime(Light.tt.unit, RampTime);
				await Promise.all([
					this.setForeignStateAsync(Light.tt.oid, { val: tt, ack: false }),
					this.writeLog(
						`[ SetTtAsync ] Set ${Light.description} (${Light.tt.oid}) to: ${tt}${Light.tt.unit}`,
					),
				]);
			});

		await Promise.all(promises).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "SetTtAsync");
		});

		if (prop === "default") await this.setStateAsync(`${Group}.transitionTime`, { val: RampTime, ack: true });
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
		bri = LightGroups[Group].setBri,
		ct = LightGroups[Group].setCt,
		color = LightGroups[Group].setColor,
	) {
		this.writeLog(`[ PowerOnAftercareAsync ] Group="${Group}" bri="${bri}" ct="${ct}" color="${color}"`, "info");

		if (LightGroups[Group].power) {
			//Nur bei anschalten ausführen

			if (!LightGroups[Group].rampOn.enabled) {
				//Wenn kein RampOn Helligkeit direkt setzen

				if (LightGroups[Group].adaptiveBri) {
					//Bei aktiviertem AdaptiveBri
					await this.SetBrightnessAsync(Group, this.AdaptiveBri(Group));
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

	/**
	 *
	 * @async
	 * @param {*} Group Groupname
	 */
	async clearRampTimeoutsAsync(Group) {
		if (Group == null) {
			const groupKeys = Object.keys(LightGroups).filter((groupKey) => !["All", "info"].includes(groupKey));

			for (const groupKey of groupKeys) {
				if (["All", "info"].includes(groupKey)) continue;

				if (typeof this.RampTimeoutObject[groupKey] === "object") {
					this.writeLog(`[ clearRampTimeout ] Timeout for group="${groupKey}" deleted.`);
					this.clearTimeout(this.RampTimeoutObject[groupKey]);
				}
			}
		} else {
			if (typeof this.RampTimeoutObject[Group] === "object") {
				this.writeLog(`[ clearRampTimeout ] Timeout for group="${Group}" deleted.`);
				this.clearTimeout(this.RampTimeoutObject[Group]);
			}
		}
		return true;
	}

	/**
	 *
	 * @async
	 * @param {string | null} Group Groupname
	 */
	async clearAutoOffTimeoutsAsync(Group) {
		const groupKeys = Object.keys(LightGroups).filter((groupKey) => !["All", "info"].includes(groupKey));

		if (Group === null) {
			for (const groupKey of groupKeys) {
				if (typeof this.AutoOffTimeoutObject[groupKey] === "object") {
					this.writeLog(`[ clearAutoOffTimeouts ] Timeout for group="${groupKey}" deleted.`);
					this.clearTimeout(this.AutoOffTimeoutObject[groupKey]);
					this.AutoOffTimeoutObject[groupKey] = null;
					this.setState(`${groupKey}.autoOffTimed.countdown`, { val: 0, ack: true });
				}
			}
		} else {
			if (this.AutoOffTimeoutObject[Group] !== null) {
				this.writeLog(`[ clearAutoOffTimeouts ] Timeout for group="${Group}" deleted.`);
				this.clearTimeout(this.AutoOffTimeoutObject[Group]);
				this.AutoOffTimeoutObject[Group] = null;
				this.setState(`${Group}.autoOffTimed.countdown`, { val: 0, ack: true });
			}
		}
		return true;
	}

	/**
	 *
	 * @async
	 * @param {*} Group Groupname
	 */
	async clearBlinkIntervalsAsync(Group) {
		if (Group === null) {
			const groupKeys = Object.keys(LightGroups).filter((groupKey) => !["All", "info"].includes(groupKey));

			for (const groupKey of groupKeys) {
				if (typeof this.BlinkIntervalObj[groupKey] === "object") {
					this.writeLog(`[ clearBlinkIntervals ] Interval for group="${groupKey}" deleted.`);
					this.clearInterval(this.BlinkIntervalObj[groupKey]);
				}
			}
		} else {
			if (typeof this.BlinkIntervalObj[Group] === "object") {
				this.writeLog(`[ clearBlinkIntervals ] Interval for group="${Group}" deleted.`);
				this.clearInterval(this.BlinkIntervalObj[Group]);
			}
		}
		return true;
	}

	/**
	 *
	 * @async
	 * @param {*} Group Groupname
	 */
	async clearTransitionTimeoutAsync(Group) {
		if (Group === null) {
			for (const Group in this.TransitionTimeoutObject) {
				if (Object.prototype.hasOwnProperty.call(this.TransitionTimeoutObject, Group)) {
					this.TransitionTimeoutObject[Group].abort();
					delete this.TransitionTimeoutObject[Group];
				}
			}
		} else {
			if (this.TransitionTimeoutObject[Group]) {
				this.TransitionTimeoutObject[Group].abort();
				delete this.TransitionTimeoutObject[Group];
			}
		}
		return true;
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

		await this.GlobalLuxHandlingAsync();
		await this.GlobalPresenceHandlingAsync();

		const resultStatesCreate = await this.createObjectsAsync();
		if (!resultStatesCreate) {
			return false;
		}

		/*
		// Check internal memory and objects of instance
		const objMemory = await this.getAdapterObjectsAsync();
		if (!objMemory) {
			this.writeLog(`Cannot read objects from instance! Init Aborted!`, "error");
			return false;
		} else {
			const objInstance = helper.createNestedObject(this.namespace, objMemory);
			const resultComparison = helper.compareAndFormatObjects(objInstance, LightGroups);
			if (resultComparison.length > 0) {
				this.writeLog(`${JSON.stringify(resultComparison)}`, "warn");
				this.writeLog(
					`Internal memory and objects of instance are not the same. Please restart the adapter or contact the developer.`,
					"error",
				);
				return false;
			}
		}
		*/
		const latlng = await this.GetSystemDataAsync();
		if (latlng) {
			this.AdaptiveCtAsync();
		}

		const resultInitCustomStates = await this.InitCustomStatesAsync();
		if (!resultInitCustomStates) {
			return false;
		}

		await this.SetLightStateAsync();

		this.writeLog(`Init finished.`, "info");
		return true;
	}

	/**
	 * Create LightGroups Object
	 * @async
	 * @description Creates Object LightGroups from system.config array
	 * @return {Promise<boolean | void>}
	 */
	async CreateLightGroupsObject() {
		if (this.config.LightGroups && this.config.LightGroups.length) {
			const regex = /^[a-zA-Z0-9_-]*$/; // Regulärer Ausdruck zur Überprüfung von erlaubten Zeichen
			this.config.LightGroups.forEach(({ Group, GroupLuxSensor }) => {
				if (!regex.test(Group)) {
					// Überprüfen, ob "Group" nur erlaubte Zeichen enthält
					this.writeLog(
						`[ CreateLightGroupsObject ] Group "${Group}" contains invalid characters. Please update the group name in instance setting. Skipping...`,
						"warn",
					);
					return; // Überspringen des Loops, wenn "Group" ungültige Zeichen enthält
				}
				LightGroups[Group] = {
					description: Group,
					LuxSensor: GroupLuxSensor,
					lights: [],
					sensors: [],
				};
			});

			return true;
		} else {
			this.writeLog(`[ CreateLightGroupsObject ] No LightGroups defined in instance settings!`, "warn");
			return;
		}
	}

	/**
	 * GlobalLuxHandlingAsync
	 * @description If a global lux sensor has been defined, its value is written to the global variable and the state is subscribed.
	 */
	async GlobalLuxHandlingAsync() {
		const { config } = this;
		const { GlobalLuxSensor } = config;
		this.ActualGenericLux = 0;

		if (!GlobalLuxSensor) {
			return;
		}

		const actualGenericLux = await this.getForeignStateAsync(GlobalLuxSensor);
		const _actualGenericLux = checks.checkObjectNumber(actualGenericLux);

		if (_actualGenericLux === null || _actualGenericLux === undefined) {
			this.log.warn(
				`[ GlobalLuxHandlingAsync ] state value of id="${GlobalLuxSensor}" is empty, null, undefined, or not a valid number!`,
			);
			return;
		}

		this.ActualGenericLux = _actualGenericLux;
		await this.subscribeForeignStatesAsync(GlobalLuxSensor);
		this.LuxSensors.push(GlobalLuxSensor);
		return true;
	}

	/**
	 * DoAllTheSensorThings
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async DoAllTheMotionSensorThings(Group) {
		this.writeLog(`[ DoAllTheMotionSensorThings ] Reaching, Group = "${Group}`);

		if (!Array.isArray(LightGroups?.[Group]?.sensors)) {
			this.writeLog(
				`[ DoAllTheMotionSensorThings ] sensors in group="${Group} not a array or not iterable or not defined!", "warn"`,
			);
			return;
		}

		await Promise.all(
			LightGroups[Group].sensors.map(async (sensor) => {
				const _motionState = await this.getForeignStateAsync(sensor.oid).catch((error) => {
					this.writeLog(`Error with id=${sensor.id} => ${error}`, "error", `DoAllTheMotionSensorThings`);
				});

				if (_motionState) {
					sensor.isMotion = _motionState.val == sensor.motionVal;
					this.writeLog(
						`[ DoAllTheMotionSensorThings ] Group="${Group}" SensorID="${sensor.oid}" MotionVal="${sensor.isMotion}"`,
					);

					await this.subscribeForeignStatesAsync(sensor.oid);
					this.MotionSensors.push(sensor.oid);
				} else {
					this.writeLog(
						`[ DoAllTheMotionSensorThings ] Group="${Group}" ${sensor.oid} has no data, skipping subscribe`,
					);
				}
			}),
		);

		return true;
	}

	/**
	 * DoAllTheLuxSensorThings
	 * @description Read the current lux value per group. However, if no individual lux sensor has been defined, a global lux sensor is assigned to the group.
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async DoAllTheLuxSensorThings(Group) {
		const luxSensor = LightGroups[Group]?.LuxSensor || this.config?.GlobalLuxSensor || "";

		LightGroups[Group].actualLux = 0;

		await this.SetValueToObjectAsync(Group, ["autoOnLux.dailyLockCounter", "autoOffLux.dailyLockCounter"], 0);

		if (!luxSensor) {
			this.writeLog(
				`[ DoAllTheLuxSensorThings ] No Luxsensor for Group="${Group}" defined, set actualLux = 0, skip handling`,
			);
			return;
		}

		if (luxSensor === this.config.GlobalLuxSensor) {
			LightGroups[Group].actualLux = this.ActualGenericLux ?? 0;
			LightGroups[Group].LuxSensor = luxSensor;
			this.writeLog(`[ DoAllTheLuxSensorThings ] Group "${Group}" using global luxsensor.`);
			return;
		}

		const individualLux = await this.getForeignStateAsync(luxSensor).catch((error) => {
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "DoAllTheLuxSensorThings");
			return;
		});
		const _individualLux = checks.checkObjectNumber(individualLux);

		if (_individualLux === null) {
			this.log.warn(
				`[ DoAllTheLuxSensorThings ] state value of id="${luxSensor}" of Group="${Group}" is empty, null or undefined!`,
			);
			return;
		}

		LightGroups[Group].actualLux = _individualLux;
		await this.subscribeForeignStatesAsync(luxSensor);
		this.LuxSensors.push(luxSensor);
		this.writeLog(
			`[ DoAllTheLuxSensorThings ] Group="${Group}" using individual luxsensor "${luxSensor}", value is: ${LightGroups[Group].actualLux}`,
		);
		return true;
	}

	/**
	 * GlobalPresenceHandlingAsync
	 */
	async GlobalPresenceHandlingAsync() {
		if (this.config.PresenceCountDp) {
			this.writeLog(`[ GlobalPresenceHandlingAsync ] PresenceCounteDp=${this.config.PresenceCountDp}`);

			const ActualPresenceCount = await this.getForeignStateAsync(this.config.PresenceCountDp);
			const _ActualPresenceCount = await checks.checkObjectNumber(ActualPresenceCount);

			if (_ActualPresenceCount === null || _ActualPresenceCount === undefined) {
				this.log.warn(
					`[ GlobalPresenceHandlingAsync ] state value of id="${this.config.PresenceCountDp}" is empty, null or undefined!`,
				);
			} else {
				this.ActualPresenceCount = { newVal: _ActualPresenceCount, oldVal: 0 };
				this.ActualPresence = this.ActualPresenceCount.newVal === 0 ? false : true;
				await this.subscribeForeignStatesAsync(this.config.PresenceCountDp);
			}
		}

		if (this.config.IsPresenceDp) {
			this.writeLog(`[ GlobalPresenceHandlingAsync ] IsPresenceDp=${this.config.IsPresenceDp}`);
			this.ActualPresence = false;

			const ActualPresence = await this.getForeignStateAsync(this.config.IsPresenceDp);
			const _ActualPresence = await checks.checkObjectBoolean(ActualPresence);

			if (_ActualPresence === null || _ActualPresence === undefined) {
				this.writeLog(
					`[ GlobalPresenceHandlingAsync ] isPresenceDp=${this.config.IsPresenceDp} is not type="boolean"!`,
					"warn",
				);
			} else {
				this.ActualPresence = _ActualPresence;
				await this.subscribeForeignStatesAsync(this.config.IsPresenceDp);
			}
		}
		return true;
	}
	/**
	 *
	 * @param {string[]} ids
	 */
	async DoTheAllChannelThings(ids) {
		for (const id of ids) {
			const modifiedId = `All.${id}`;
			const obj = await this.getObjectAsync(modifiedId).catch((error) => {
				this.writeLog(
					`Not able to get object of id="${modifiedId}". Please check your config! Init aborted! Error: ${error}`,
					"error",
					"DoAllTheAllChannelThings",
				);
				return;
			});

			const state = await this.getStateAsync(modifiedId);

			if (!state) {
				this.writeLog(
					`State: "${modifiedId}" is NULL or undefined! Init aborted!`,
					"error",
					"StatesCreateAsync",
				);
				return;
			}

			if (id === "power") {
				await this.SetValueToObjectAsync("All", "powerNewVal", state.val);
			}

			await this.SetValueToObjectAsync("All", id, state.val);

			obj?.common.write && (await this.subscribeStatesAsync(modifiedId));
		}

		const modifiedIds = ids.map((id) => `${this.namespace}.All.${id}`);
		this.keepList.push(`${this.namespace}.All`, ...modifiedIds);

		return true;
	}

	async createObjectsAsync() {
		for (const [Group] of Object.entries(LightGroups)) {
			//if (["All", "info"].includes(Group)) continue;

			await this.CreateDeviceAsync(Group, {
				name: Group,
			});

			this.keepList.push(
				`${this.namespace}.${Group}`,
				`${this.namespace}.info.connection`,
				`${this.namespace}.info`,
			);

			await this.DoAllTheMotionSensorThings(Group);
			await this.DoAllTheLuxSensorThings(Group);

			for (const [key, obj] of Object.entries(objects)) {
				const id = `${Group}.${key}`;

				if (obj.type === "channel") {
					await this.CreateChannelAsync(id, obj.common);
					this.keepList.push(`${this.namespace}.${id}`);
				}
			}

			for (const [key, obj] of Object.entries(objects)) {
				if (obj.type === "state") {
					const id = `${Group}.${key}`;
					await this.CreateStateAsync.call(this, id, obj.common);
					this.keepList.push(`${this.namespace}.${id}`);
				}
			}
		}

		//DoTheAllChannelThings
		const ids = ["power", "anyOn"];
		const result = await this.DoTheAllChannelThings(ids);
		if (!result) return false;

		await this.deleteNonExistentObjectsAsync();

		return true;
	}

	/**
	 * Deletes objects that do not exist in the given keepList.
	 *
	 * @async
	 * @returns {Promise<void>} - A Promise that resolves after all objects have been deleted.
	 */
	async deleteNonExistentObjectsAsync() {
		try {
			const allObjects = [];
			const objects = await this.getAdapterObjectsAsync();
			for (const o in objects) {
				allObjects.push(o);
			}

			for (let i = 0; i < allObjects.length; i++) {
				const id = allObjects[i];
				if (this.keepList.indexOf(id) === -1) {
					await this.delObjectAsync(id, { recursive: true });
					this.writeLog(`Unuses object deleted ${id}`, "info");
				}
			}
		} catch (error) {
			this.writeLog(`Error by deleting unused object! Error: ${error}`, "error", "deleteNonExistentObjectsAsync");
		}
	}

	/**
	 * Create and update state
	 * @author Schmakus
	 * @async
	 * @param {string} id path to datapoint
	 * @param {object} common common of the object
	 */
	async CreateStateAsync(id, common) {
		const common_old = (await this.getObjectAsync(id))?.common || {};

		if (JSON.stringify(common_old) !== JSON.stringify(common)) {
			this.writeLog(`[ CreateStateAsync ] State: ${id} created or updated.`);

			await this.setObjectAsync(id, {
				type: "state",
				common: common,
				native: {},
			}).catch((error) => {
				this.writeLog(
					`Not able to set state of id="${id}". Please check your config! Init aborted! Error: ${error}`,
					"error",
					"CreateStateAsync",
				);
				return;
			});
		}

		const state = await this.getStateAsync(id).catch((error) => {
			this.writeLog(
				`Not able to get state of id="${id}". Please check your config! Init aborted! Error: ${error}`,
				"error",
				"CreateStateAsync",
			);
			return;
		});

		if (!state) {
			this.writeLog(`State: "${id}" is NULL or undefined! Init aborted!`, "error", "CreateStateAsync");
			return;
		} else {
			const parts = id.split(".");
			const param = parts.slice(1).join(".");
			await this.SetValueToObjectAsync(parts[0], param, state.val);

			const actionMap = {
				power: "powerNewVal",
				bri: "setBri",
				ct: "setCt",
				color: "setColor",
			};

			const action = actionMap[parts[1]];

			if (parts.length === 2 && action) {
				await this.SetValueToObjectAsync(parts[0], action, state.val);
			}

			common.write && (await this.subscribeStatesAsync(id));
			return true;
		}
	}
	/**
	 * Create and update channel
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {ioBroker.ChannelCommon} common desc of the channel
	 */
	async CreateChannelAsync(dp, common) {
		try {
			const common_old = (await this.getObjectAsync(dp))?.common || {};
			if (JSON.stringify(common_old) !== JSON.stringify(common)) {
				this.writeLog(`[ CreateChannelAsync ] Channel: ${dp} created or updated.`);
				await this.setObjectAsync(dp, {
					type: "channel",
					common: common,
					native: {},
				});
			}
			return true;
		} catch (error) {
			this.writeLog(`Not able create or update channel (${dp}). Error: ${error}`, "error", "CreateChannelAsync");
			return false;
		}
	}

	/**
	 * Create and update device
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {ioBroker.DeviceCommon} common desc of the device
	 */
	async CreateDeviceAsync(dp, common) {
		try {
			const common_old = (await this.getObjectAsync(dp))?.common || {};
			if (JSON.stringify(common_old) !== JSON.stringify(common)) {
				this.writeLog(`[ CreateChannelAsync ] Device: ${dp} created or updated.`);
				await this.setObjectAsync(dp, {
					type: "device",
					common: common,
					native: {},
				});
			}
			return true;
		} catch (error) {
			this.writeLog(`Not able create or update device (${dp}). Error: ${error}`, "error", "CreateDeviceAsync");
			return false;
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
			this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "InitCustomStatesAsync");
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
		return true;
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
					`[ checkLightGroupParameterAsync ] Can't get information for ${stateID}, state will be ignored`,
					"warn",
				);
				this.activeStates = helper.removeValue(this.activeStates, stateID);
				this.unsubscribeForeignStates(stateID);
				return;
			}
		} catch (error) {
			this.writeLog(
				`[ checkLightGroupParameterAsync ] ${stateID} is incorrectly correctly formatted, ${JSON.stringify(
					error,
				)}`,
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
					`[ checkLightGroupParameterAsync ] No Group Name defined for StateID: ${stateID}. Initalisation aborted`,
					"warn",
				);
				return;
			}

			if (Array.isArray(customData.group)) {
				this.log.debug(`[ checkLightGroupParameterAsync ] LightGroups: ${JSON.stringify(LightGroups)}`);
				const missingGroups = customData.group.filter(
					(group) => !Object.prototype.hasOwnProperty.call(LightGroups, group),
				);

				if (missingGroups.length > 0) {
					if (this.config.deleteUnusedConfig) {
						this.writeLog(
							`[ checkLightGroupParameterAsync ] Light group(s) "${missingGroups.join(
								", ",
							)}" were deleted by the user in the instance settings! LightControl settings will be updated for this StateID: ${stateID})`,
							"warn",
						);
						const newGroups = customData.group.filter((group) => !missingGroups.includes(group));

						stateInfo.common.custom[this.namespace].group =
							newGroups.length === 1 ? newGroups[0].toString() : newGroups;
						stateInfo.common.custom[this.namespace].enabled = newGroups.length > 0;

						await this.setForeignObjectAsync(stateID, stateInfo);
					} else {
						this.writeLog(
							`[ checkLightGroupParameterAsync ] Light group(s) "${missingGroups.join(
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
				if (!Object.prototype.hasOwnProperty.call(LightGroups, customData.group)) {
					if (this.config.deleteUnusedConfig) {
						this.writeLog(
							`[ checkLightGroupParameterAsync ] Light group "${customData.group}" was deleted by the user in the instance settings! LightControl settings will be deactivated for this StateID: ${stateID})`,
							"warn",
						);

						stateInfo.common.custom[this.namespace].enabled = false;

						await this.setForeignObjectAsync(stateID, stateInfo);
					} else {
						this.writeLog(
							`[ checkLightGroupParameterAsync ] Light group "${customData.group}" was deleted by the user in the instance settings! (StateID: ${stateID})`,
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

				if (LightGroups[customData.group].lights && Array.isArray(LightGroups[customData.group].lights)) {
					const Lights = LightGroups[customData.group].lights;

					// Überprüfen, ob jedes Objekt eine description-Eigenschaft hat
					const allObjectsHaveDescription = Lights.every((x) => x && typeof x.description === "string");

					if (allObjectsHaveDescription) {
						///Find index in Lights Array if description available
						const index = Lights.findIndex((x) => x.description === customData.description);

						let Light;

						if (checks.isNegative(index)) {
							Light = Lights.length === 0 ? (Lights[0] = {}) : (Lights[Lights.length] = {});
						} else {
							Light = Lights[index];
						}

						// Add parameters to Light
						Light.description = customData.description;
						Light[customData.func] = getSubset(customData, ...params[customData.func]);

						this.writeLog(
							`[ buildLightGroupParameterAsync ] Type: Light, in Group: ${
								LightGroups[customData.group].description
							} with Lights: ${JSON.stringify(Lights)} and Light: ${JSON.stringify(
								Light,
							)} with Index: ${index}`,
						);
					} else {
						this.writeLog(
							`[ buildLightGroupParameterAsync ] Any Light of Group=${
								LightGroups[customData.group].description
							} has no own description. Init aborted`,
							"warn",
						);
					}
				} else {
					this.writeLog(
						`Any Light has no description. Init aborted. No Index found: ${JSON.stringify(
							LightGroups[customData.group].lights,
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
						LightGroups[customData.group].description
					}}`,
				);
				const Sensors = LightGroups[customData.group].sensors;
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
		this.writeLog(`[ buildLightGroupParameterAsync ] Updated LightGroups: ${JSON.stringify(LightGroups)}`);
		return true;
	}

	/**
	 * SummarizeSensors
	 * @async
	 * @param {string} Group
	 */
	async SummarizeSensorsAync(Group) {
		let Motionstate = false;

		for (const Sensor of LightGroups[Group].sensors) {
			if (Sensor.isMotion) {
				Motionstate = true;
			}
		}

		if (LightGroups[Group].isMotion !== Motionstate) {
			this.writeLog(`[ SummarizeSensorsAync ] Summarized IsMotion for Group="${Group}" = ${Motionstate}.`);
			LightGroups[Group].isMotion = Motionstate;
			await this.setStateAsync(`${Group}.isMotion`, { val: Motionstate, ack: true });
			await this.AutoOnMotionAsync(Group);
			await this.AutoOffTimedAsync(Group);
		} else {
			this.writeLog(
				`[ SummarizeSensorsAync ] Motionstate of Group: ${Group} = ${Motionstate}, nothing changed -> nothin to do`,
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
		const groupLength = Object.keys(LightGroups).length - 1;

		await Promise.all([
			this.SetValueToObjectAsync("All", "anyOn", countGroups > 0),
			this.SetValueToObjectAsync("All", "power", countGroups === groupLength),
		]);

		await Promise.all([
			this.setStateAsync("All.anyOn", LightGroups.All.anyOn, true),
			this.setStateAsync("All.power", LightGroups.All.power, true),
		]);
		this.writeLog(`[ SetLightState ] Set State "All.anyOn" to ${LightGroups.All.anyOn} from function="${from}"`);
	}

	/**
	 * Helper: count Power in Groups
	 */
	countGroups() {
		let i = 0;
		for (const Group in LightGroups) {
			if (["All", "info"].includes(Group)) continue;

			if (LightGroups[Group].power) {
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
				this.writeLog(`Error: ${error.message}, Stack: ${error.stack}`, "error", "deaktivateOwnIdAsync");
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
		for (const Groups of Object.keys(LightGroups)) {
			//Check Lights
			const lightArray = LightGroups[Groups].lights;
			if (lightArray) {
				for (const Lights of lightArray) {
					keys.forEach((key) => {
						if (Lights[key]) {
							if (Lights[key].oid === stateID) {
								this.writeLog(
									`ID = ${stateID} will delete in Group = "${LightGroups[Groups].description}", Param = ${key}`,
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
			const _oldArray = LightGroups[Groups].sensors;
			if (_oldArray && _oldArray !== "undefined") {
				LightGroups[Groups].sensors = LightGroups[Groups].sensors.filter((object) => {
					return object.oid !== stateID;
				});

				// Comparing Sensor Array
				const equalsCheck = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
				if (!equalsCheck(_oldArray, LightGroups[Groups].sensors)) {
					this.writeLog(
						`Sensor with ID = ${stateID} will delete in Group = "${LightGroups[Groups].description}"`,
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
		if (Group === "All" && !Object.prototype.hasOwnProperty.call(LightGroups, Group)) {
			LightGroups["All"] = {};
		}

		if (!Object.prototype.hasOwnProperty.call(LightGroups, Group)) {
			this.log.warn(`[ SetValueToObjectAsync ] Group="${Group}" not exist in LightGroups-Object!`);
			return;
		}

		if (value === null || value === undefined) {
			this.log.error(
				`[ SetValueToObjectAsync ] Value="${value}" is undefined or null. check your config and restart adapter!`,
			);
			return;
		}

		const group = LightGroups[Group];
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
		if (logtype === "error") this.instanceReady(false);
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
