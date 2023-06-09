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
const colorConv = require("./lib/colorCoversation");
const { params } = require("./lib/params");
const { DeviceTemplate, DeviceAllTemplate } = require(`./lib/groupTemplates`);
const {
	TestTemplateLamps,
	TestTemplateMotionSensors,
	TestTemplateLuxSensors,
	TestTemplatePresence,
} = require(`./lib/testTemplates`);
//const { objects } = require("./lib/objects");

// Sentry error reporting, disable when testing alpha source code locally!
const disableSentry = false;

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
		this.Settings = {};
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
		//this.GlobalSettings = this.config;
		this.Settings = this.config;
		this.writeLog(`[ onReady ] LightGroups from Settings: ${JSON.stringify(this.Settings?.LightGroups)}`);

		//Create LightGroups Object from GroupNames
		await this.CreateLightGroupsObject();

		//Create all States, Devices and Channels
		if (Object.keys(this.LightGroups).length !== 0) {
			await this.Init();
			await this.InitCustomStates();
			await this.SetLightState();
		} else {
			this.writeLog(`[ onReady ] No Init because no LightGroups defined in settings`);
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
			clearTimeout(this.TickerIntervall);

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
		try {
			const ids = id.split(".");

			if (state && state.val !== null) {
				this.writeLog(`[ onStateChange ] state ${id} changed: ${state.val} (ack = ${state.ack})`);

				if (ids[0] == "lightcontrol") {
					if (!state.ack) {
						const NewVal = state.val;
						let OldVal;

						const OwnId = await helper.removeNamespace(this.namespace, id);
						const { Group, Prop } = await helper.ExtractGroupAndProp(OwnId);

						if (Prop === "power" && Group !== "All") {
							OldVal = this.LightGroups[Group].powerOldVal = this.LightGroups[Group].powerNewVal;
							this.LightGroups[Group].powerNewVal = NewVal;
						}

						if (Group === "All") {
							await this.SetMasterPower(NewVal);
						} else {
							await this.Controller(Group, Prop, NewVal, OldVal, OwnId);
						}
					}
				} else {
					//Handle External States
					if (state.ack || !state.ack) {
						this.writeLog(`[ onStateChange ] ExternalState`);

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
									await this.Controller(
										Group.description,
										"actualLux",
										state.val,
										Group.actualLux,
										"",
									);
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

													await this.SummarizeSensors(Group);
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
						} else if (this.Settings.IsPresenceDp === id) {
							this.writeLog(`[ onStateChange ] It's IsPresenceDp: ${id}`);

							this.ActualPresence = typeof state.val === "boolean" ? state.val : false;
							await this.AutoOnPresenceIncrease();

							//Check if it's Presence Counter
						} else if (this.Settings.PresenceCountDp === id) {
							this.writeLog(`[ onStateChange ] It's PresenceCountDp: ${id}`);

							this.ActualPresenceCount.oldVal = this.ActualPresenceCount.newVal;
							this.ActualPresenceCount.newVal = typeof state.val === "number" ? state.val : 0;

							if (this.ActualPresenceCount.newVal > this.ActualPresenceCount.oldVal) {
								this.writeLog(
									`[ onStateChange ] PresenceCountDp value is greater than old value: ${state.val}`,
								);
								await this.AutoOnPresenceIncrease();
							}
						}
					}
				}
			} else {
				// The state was deleted
				this.writeLog(`[ onStateChange ] state ${id} deleted`);
			}
		} catch (error) {
			this.errorHandling(error, "onStateChange");
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
	async Controller(Group, prop1, NewVal, OldVal, id = "") {
		//Used by all
		try {
			let handeled = false;

			this.writeLog(
				`[ Controller ] Reaching, Group="${Group}" Property="${prop1}" NewVal="${NewVal}", ${
					OldVal === undefined ? "" : "OldVal=" + OldVal
				}"`,
				"info",
			);

			if (prop1 !== "power") await helper.SetValueToObject(this.LightGroups[Group], prop1, NewVal);

			switch (prop1) {
				case "actualLux":
					if (!this.LightGroups[Group].powerCleaningLight) {
						//Autofunktionen nur wenn Putzlicht nicht aktiv
						await this.AutoOnLux(Group);
						await this.AutoOffLux(Group);
						if (this.LightGroups[Group].adaptiveBri)
							await this.SetBrightness(Group, await this.AdaptiveBri(Group));
						await this.AutoOnMotion(Group);
					}
					handeled = true;
					break;
				case "isMotion":
					if (!this.LightGroups[Group].powerCleaningLight) {
						if (this.LightGroups[Group].isMotion && this.LightGroups[Group].power) {
							//AutoOff Timer wird nach jeder Bewegung neugestartet
							await this.AutoOffTimed(Group);
						}

						await this.AutoOnMotion(Group);
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
					await this.AutoOffLux(Group);
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
					this.AutoOnLux(Group);
					handeled = true;
					break;
				case "autoOnPresenceIncrease.enabled":
					break;
				case "autoOnPresenceIncrease.bri":
					break;
				case "autoOnPresenceIncrease.color":
					break;
				case "autoOnPresenceIncrease.minLux":
					await this.AutoOnPresenceIncrease();
					handeled = true;
					break;
				case "adaptiveCt.enabled":
					break;
				case "adaptiveCt.adaptiveCtMode":
					break;
				case "adaptiveCt.adaptiveCtTime":
					break;
				case "bri":
					await this.SetBrightness(Group, this.LightGroups[Group].bri);
					handeled = true;
					break;
				case "ct":
					await this.SetCt(Group, this.LightGroups[Group].ct);
					await this.SetWhiteSubstituteColor(Group);
					handeled = true;
					break;
				case "color":
					if (await helper.CheckHex(NewVal)) {
						this.LightGroups[Group].color = NewVal.toUpperCase();
						await this.SetColor(Group, this.LightGroups[Group].color);
						if (this.LightGroups[Group].color == "#FFFFFF") await this.SetWhiteSubstituteColor(Group);
						await this.SetColorMode(Group);
					}
					handeled = true;
					break;
				case "transitionTime":
					await this.SetTt(Group, await helper.limitNumber(NewVal, 0, 64000), prop1);
					handeled = true;
					break;
				case "power":
					if (NewVal !== OldVal) {
						await this.GroupPowerOnOff(Group, NewVal); //Alles schalten
						if (NewVal) await this.PowerOnAftercare(Group);
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
					await this.GroupPowerCleaningLightOnOff(Group, NewVal);
					handeled = true;
					break;
				case "adaptiveBri":
					await this.SetBrightness(Group, await this.AdaptiveBri(Group));
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
						await this.SetValueToObject(Group, ["blink.infinite", "blink.stop"], [true, false]);
						await this.blink(Group);
					} else if (!NewVal) {
						await this.SetValueToObject(Group, "blink.stop", true);
					}
					handeled = true;
					break;
				case "blink.start":
					await this.SetValueToObject(Group, ["blink.stop", "blink.infinite"], false);
					await this.blink(Group);
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
		} catch (error) {
			this.errorHandling(error, "Controller");
			return false;
		}
	}

	/**
	 * Is called if an object changes to ensure (de-) activation of calculation or update configuration settings
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	async onObjectChange(id, obj) {
		//ToDo : Verify with test-results if debounce on object change must be implemented
		try {
			const stateID = id;

			// Check if object is activated for LightControl
			if (obj && obj.common) {
				// Verify if custom information is available regarding LightControl
				if (
					obj.common.custom &&
					obj.common.custom[this.namespace] &&
					obj.common.custom[this.namespace].enabled
				) {
					//Check if its an own Lightcontrol State
					if (stateID.includes(this.namespace)) {
						await this.deaktivateOwnId(stateID);
					} else {
						this.writeLog(
							`[ onObjectChange ] Object array of LightControl activated state changed : ${JSON.stringify(
								obj,
							)} stored Objects : ${JSON.stringify(this.activeStates)}`,
						);

						// Verify if the object was already activated, if not initialize new parameter
						if (!this.activeStates.includes(stateID)) {
							this.writeLog(`[ onObjectChange ] Enable LightControl for : ${stateID}`, "info");
							await this.buildLightGroupParameter(stateID);

							if (!this.activeStates.includes(stateID)) {
								this.writeLog(
									`[ onObjectChange ] Cannot enable LightControl for ${stateID}, check settings and error messages`,
									"warn",
								);
							}
						} else {
							this.writeLog(`[ onObjectChange ] Updating LightControl configuration for : ${stateID}`);
							//Cleaning LightGroups from ID and set it new
							await this.deleteStateIdFromLightGroups(stateID);
							await this.buildLightGroupParameter(stateID);

							if (!this.activeStates.includes(stateID)) {
								this.writeLog(
									`[ onObjectChange ] Cannot update LightControl configuration for ${stateID}, check settings and error messages`,
									"warn",
								);
							}
						}
					}
				} else if (this.activeStates.includes(stateID)) {
					this.activeStates = await helper.removeValue(this.activeStates, stateID);
					this.writeLog(`[ onObjectChange ] Disabled LightControl for : ${stateID}`, "info");

					await this.deleteStateIdFromLightGroups(stateID);

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
		} catch (error) {
			this.errorHandling(error, "onObjectChange");
		}
	}

	/**
	 * Is called if a message is comming
	 */
	async onMessage(msg) {
		this.writeLog(`[ onMessage ] Incomming Message from: ${JSON.stringify(msg)}`);
		if (msg.callback) {
			switch (msg.command) {
				case "LightGroup": {
					try {
						const groups = [];
						if (Object.keys(this.LightGroups).length !== 0) {
							for (const Group in this.LightGroups) {
								// iterate through all existing groups and extract group names
								if (Group === "All") continue;
								groups.push({ value: Group, label: Group });
							}
						}
						this.sendTo(msg.from, msg.command, groups, msg.callback);
						this.writeLog(`[ onMessage ] LightGroup => LightGroups Callback: ${JSON.stringify(groups)}.`);
					} catch (error) {
						this.errorHandling(error, "onMessage // case LightGroup");
					}
					break;
				}

				case "LightName": {
					try {
						const lightGroups = msg.message.LightGroups;
						const DEFAULT_LIGHT = { value: "Example_Light", label: "Example_Light" };
						this.writeLog(`[ onMessage ] LightName => getLights for Groups: ${lightGroups}.`);
						const lights = [];

						if (
							lightGroups &&
							this.LightGroups &&
							Object.prototype.hasOwnProperty.call(this.LightGroups, lightGroups)
						) {
							const group = this.LightGroups[lightGroups];
							if (group && group.lights) {
								for (const light of group.lights) {
									lights.push({ value: light.description, label: light.description });
									this.writeLog(
										`[ onMessage ] LightName => Light: ${light.description} in Group: ${lightGroups} found.`,
									);
								}
							}
						}

						if (!lights.length) {
							lights.push(DEFAULT_LIGHT);
						}
						this.sendTo(msg.from, msg.command, lights, msg.callback);
					} catch (error) {
						this.errorHandling(error, "onMessage // case LightName");
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
						this.errorHandling(error, "onMessage // case checkIdForDuplicates");
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
	async GroupPowerOnOff(Group, OnOff) {
		if (!this.LightGroups[Group]) {
			this.writeLog(`[ GroupPowerOnOff ] Group="${Group}" not defined. Please check your config !`, "warn");
			return;
		}
		if (!this.LightGroups[Group].rampOn?.enabled || !this.LightGroups[Group].rampOff?.enabled) {
			this.writeLog(
				`[ GroupPowerOnOff ] No rampOn or rampOff states available for group="${Group}". Please check your config and restart the this!!`,
				"warn",
			);
			return;
		}
		if (!this.LightGroups[Group].lights.some((Light) => Light.power?.oid || Light.bri?.oid)) {
			await this.writeLog(
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
				await this.SimpleGroupPowerOnOff(Group, OnOff);

				if (this.LightGroups[Group].autoOffTimed.enabled) {
					//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
					await this.AutoOffTimed(Group);
				}
			} else {
				await this.TurnOnWithRamping(Group);
			}
		} else {
			// Ausschalten ohne Ramping */
			if (!this.LightGroups[Group].rampOff.enabled) {
				if (this.LightGroups[Group].rampOn.enabled) {
					//Vor dem ausschalten Helligkeit auf 2 (0+1 wird bei manchchen Devices als aus gewertet) um bei rampon nicht mit voller Pulle zu starten
					await this.SetBrightness(Group, 2, "ramping");
				}

				await this.SimpleGroupPowerOnOff(Group, OnOff);
				this.LightGroups[Group].power = false;
			} else {
				// Ausschalten mit Ramping */
				await this.TurnOffWithRamping(Group);
			}
		}

		await Promise.all([this.setStateAsync(Group + ".power", OnOff, true), this.SetLightState("GroupPowerOnOff")]);
		return true;
	}

	/**
	 * SimpleGroupPowerOnOff
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async SimpleGroupPowerOnOff(Group, OnOff) {
		const operation = OnOff ? "on" : "off";
		if (!this.LightGroups[Group]) {
			this.writeLog(`[ SimpleGroupPowerOnOff ] Group="${Group}" not defined. Please check your config!`, "warn");
			return;
		}
		if (!this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
			this.writeLog(
				`[ SimpleGroupPowerOnOff ] Not able to switching Group = "${Group}". No lights are defined!!`,
				"warn",
			);
			return;
		}

		const outlast = this.OutlastDevices(this.LightGroups[Group].lights, OnOff);

		const useBrightness = this.LightGroups[Group].lights
			.filter((Light) => Light?.bri?.oid && Light?.bri?.useBri)
			.map(async (Light) => {
				const brightness = this.LightGroups[Group].adaptiveBri
					? await this.AdaptiveBri(Group)
					: this.LightGroups[Group].bri;

				await Promise.all([
					this.setDeviceBri(Light, OnOff ? brightness : 0),
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
	async DeviceSwitch(Group, OnOff) {
		try {
			this.writeLog(`[ DeviceSwitch ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

			const promises = this.LightGroups[Group].lights
				.filter((Light) => !Light.bri?.oid && Light.power?.oid)
				.map(async (Light) => {
					await Promise.all([
						this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal),
						this.writeLog(
							`[ DeviceSwitch ] Switching ${Light.description} (${Light.power.oid}) to: ${OnOff}`,
						),
					]);
				});

			await Promise.all(promises);
		} catch (error) {
			this.errorHandling(error, "DeviceSwitch");
		}
	}

	/**
	 * DeviceSwitch lights before ramping (if brightness state available and not use Bri for ramping)
	 * @description Ausgelagert von GroupOnOff da im Interval kein await möglich
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async DeviceSwitchForRamping(Group, OnOff) {
		try {
			this.writeLog(`[ DeviceSwitchForRamping ] Reaching for Group="${Group}, OnOff="${OnOff}"`);

			const promises = this.LightGroups[Group].lights
				.filter((Light) => Light?.bri?.oid && !Light?.bri?.useBri && Light?.power?.oid)
				.map((Light) => {
					this.setForeignStateAsync(Light.power.oid, OnOff ? Light.power.onVal : Light.power.offVal);
				});
			await Promise.all(promises);
		} catch (error) {
			this.errorHandling(error, "DeviceSwitchForRamping");
		}
	}

	/**
	 * OutlastDevices simple lights with no brightness state
	 * @description Switch simple lights with no brightness state
	 * @async
	 * @function
	 * @param {array} Lights Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {boolean} OnOff true/false from power state
	 */
	async OutlastDevices(Lights, OnOff) {
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
	async BrightnessDevicesSwitchPower(Lights, OnOff) {
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
	async BrightnessDevicesWithRampTime(Lights, Brightness, RampTime) {
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
	 * @param {boolean} rampUp RampUp = true; RampDown = false
	 */
	async RampWithInterval(Group, rampUp = true) {
		const Lights = this.LightGroups[Group]?.lights || [];
		if (!this.Settings?.RampSteps) {
			this.writeLog(
				`[ RampWithInterval ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.Settings.RampSteps;
		const RampTime = await helper.limitNumber(this.LightGroups[Group].rampOn.time, 10);
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

			if (promises.length) await Promise.all(promises);

			//Interval stoppen und einfache Lampen schalten
			if (LoopCount >= RampSteps || !promises.length) {
				await this.clearRampIntervals(Group);
				return true;
			}
		}, Math.round(RampTime / RampSteps) * 1000);
	}

	/**
	 * TurnOnWithRamping
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async TurnOnWithRamping(Group) {
		const funcName = "TurnOnWithRamping";
		if (!this.Settings?.RampSteps) {
			this.writeLog(
				`[ ${funcName} ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.Settings.RampSteps;
		let LoopCount = 0;
		//
		// ******* Anschalten mit ramping * //
		//
		await this.clearRampIntervals(Group);
		if (this.LightGroups[Group]?.rampOn?.enabled && this.LightGroups[Group].rampOn?.switchOutletsLast) {
			this.writeLog(`[ ${funcName} ] Switch off with ramping and simple lamps last for Group="${Group}"`);

			await this.BrightnessDevicesSwitchPower(this.LightGroups[Group].lights, true); // Turn on lights for ramping is no use Bri is used
			await this.RampWithInterval(Group, true); // Returns true if finished or no lights with ramping without transition time

			if (this.LightGroups[Group].autoOffTimed.enabled) {
				//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren
				await this.AutoOffTimed(Group);
			}
		} else if (this.LightGroups[Group].rampOn.enabled && !this.LightGroups[Group].rampOn.switchOutletsLast) {
			//Anschalten mit Ramping und einfache Lampen zuerst

			this.writeLog(`[ ${funcName} ] Anschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			await this.DeviceSwitch(Group, true); // Einfache Lampen
			await this.DeviceSwitchForRamping(Group, true); //Restliche Lampen

			// Interval starten
			this.RampIntervalObject[Group] = this.setInterval(async () => {
				// Helligkeit erhöhen
				await this.SetBrightness(
					Group,
					Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
					"ramping",
				);

				LoopCount++;

				// Intervall stoppen
				if (LoopCount >= RampSteps) {
					if (this.LightGroups[Group].autoOffTimed.enabled) {
						//Wenn Zeitabschaltung aktiv und Anschaltung, AutoOff aktivieren

						await this.AutoOffTimed(Group);
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
	async TurnOffWithRamping(Group) {
		const funcName = "TurnOffWithRamping";
		if (!this.Settings?.RampSteps) {
			this.writeLog(
				`[ ${funcName} ] No RampSteps defined. Please check your config! RampWithInterval aborted!`,
				"warn",
			);
			return;
		}
		const RampSteps = this.Settings.RampSteps;
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
				await this.SetBrightness(
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
					await this.DeviceSwitchForRamping(Group, false); //restliche Lampen
					await this.DeviceSwitch(Group, false); // einfache Lampen
					this.LightGroups[Group].power = false;
					this.writeLog(`Result of TurnOffWithRamping: ${this.LightGroups[Group].power}`);
				}
			}, Math.round(this.LightGroups[Group].rampOff.time / RampSteps) * 1000);
		} else if (this.LightGroups[Group].rampOff.enabled && !this.LightGroups[Group].rampOff.switchOutletsLast) {
			////Ausschalten mit Ramping und einfache Lampen zuerst

			this.writeLog(`[ GroupPowerOnOff ] Ausschalten mit Ramping und einfache Lampen zuerst für Group="${Group}`);

			//Ausschalten von Lampen, welche keinen Brighness State haben

			await this.clearRampIntervals(Group);
			await this.DeviceSwitch(Group, false); // einfache Lampen

			// Intervall starten
			this.RampIntervalObject[Group] = this.setInterval(async () => {
				await this.SetBrightness(
					Group,
					this.LightGroups[Group].bri -
						this.LightGroups[Group].bri / RampSteps -
						Math.round(RampSteps * LoopCount * (this.LightGroups[Group].bri / 100)),
					"ramping",
				);

				LoopCount++;
				// Intervall stoppen
				if (LoopCount >= RampSteps) {
					await this.DeviceSwitchForRamping(Group, false); // restliche Lampen
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
	async GroupPowerCleaningLightOnOff(Group, OnOff) {
		const funcName = "GroupPowerCleaningLightOnOff";
		try {
			this.writeLog(
				`[ ${funcName} ] Reaching GroupPowerCleaningLightOnOff for Group="${Group}, OnOff="${OnOff}"`,
			);

			await this.clearAutoOffTimeouts(Group);

			if (OnOff) {
				if (this.LightGroups[Group].power) {
					await Promise.all([this.SetBrightness(Group, 100), this.SetCt(Group, 6500)]);
					this.LightGroups[Group].lastPower = true;
				} else {
					this.LightGroups[Group] = {
						power: true,
						lastPower: false,
					};
					await this.SimpleGroupPowerOnOff(Group, true);
					await Promise.all([this.SetBrightness(Group, 100), this.SetCt(Group, 6500)]);
				}
			} else {
				const brightness = this.LightGroups[Group].adaptiveBri
					? await this.AdaptiveBri(Group)
					: this.LightGroups[Group].bri;

				await Promise.all([
					this.SetBrightness(Group, brightness),
					this.SetCt(Group, this.LightGroups[Group].ct),
				]);

				if (!this.LightGroups[Group].lastPower) {
					this.LightGroups[Group].power = false;
					await this.SimpleGroupPowerOnOff(Group, false);
				}
			}

			await this.setStateAsync(Group + ".powerCleaningLight", OnOff, true);
		} catch (error) {
			this.errorHandling(error, funcName, `Group="${Group}"`);
		}
	}

	/**
	 * AutoOnLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOnLux(Group) {
		const LightGroup = this.LightGroups[Group];

		if (!LightGroup) {
			return;
		}

		const { enabled, actualLux, autoOnLux, power, bri, color, ct } = LightGroup;

		this.writeLog(
			`[ AutoOnLux ] Group="${Group} enabled="${this.LightGroups[Group].autoOnLux.enabled}", actuallux="${this.LightGroups[Group].actualLux}", minLux="${this.LightGroups[Group].autoOnLux.minLux}" LightGroups[Group].autoOnLux.dailyLock="${this.LightGroups[Group].autoOnLux.dailyLock}"`,
		);

		let tempBri = 0;
		let tempColor = "";

		if (this.LightGroups[Group].autoOnLux.operator == "<") {
			if (
				this.LightGroups[Group].autoOnLux.enabled &&
				!this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOnLux.dailyLock &&
				this.LightGroups[Group].actualLux <= this.LightGroups[Group].autoOnLux.minLux
			) {
				this.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if (
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenPresence && this.ActualPresence) ||
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOff(Group, true);
					tempBri =
						this.LightGroups[Group].autoOnLux.bri !== 0
							? this.LightGroups[Group].autoOnLux.bri
							: (tempBri = this.LightGroups[Group].bri);
					await this.SetWhiteSubstituteColor(Group);
					tempColor =
						this.LightGroups[Group].autoOnLux.color !== ""
							? this.LightGroups[Group].autoOnLux.color
							: (tempColor = this.LightGroups[Group].color);
					await this.PowerOnAftercare(Group, tempBri, this.LightGroups[Group].ct, tempColor);
				}

				this.LightGroups[Group].autoOnLux.dailyLock = true;

				await this.setStateAsync(Group + ".autoOnLux.dailyLock", true, true);
			} else if (
				this.LightGroups[Group].autoOnLux.dailyLock &&
				this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOnLux.minLux
			) {
				//DailyLock zurücksetzen

				this.LightGroups[Group].autoOnLux.dailyLockCounter++;

				if (this.LightGroups[Group].autoOnLux.dailyLockCounter >= 5) {
					//5 Werte abwarten = Ausreisserschutz wenns am morgen kurz mal dunkler wird

					this.LightGroups[Group].autoOnLux.dailyLockCounter = 0;
					this.LightGroups[Group].autoOnLux.dailyLock = false;
					await this.setStateAsync(Group + ".autoOnLux.dailyLock", false, true);
					this.log.info(`AutoOn_Lux() setting DailyLock to ${this.LightGroups[Group].autoOnLux.dailyLock}`);
				}
			}
		} else if (this.LightGroups[Group].autoOnLux.operator == ">") {
			if (
				this.LightGroups[Group].autoOnLux.enabled &&
				!this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOnLux.dailyLock &&
				this.LightGroups[Group].actualLux >= this.LightGroups[Group].autoOnLux.minLux
			) {
				this.log.info(`AutoOn_Lux() activated Group="${Group}"`);

				if (
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenPresence && this.ActualPresence) ||
					(this.LightGroups[Group].autoOnLux.switchOnlyWhenNoPresence && !this.ActualPresence)
				) {
					await this.GroupPowerOnOff(Group, true);
					tempBri =
						this.LightGroups[Group].autoOnLux.bri !== 0
							? this.LightGroups[Group].autoOnLux.bri
							: (tempBri = this.LightGroups[Group].bri);
					await this.SetWhiteSubstituteColor(Group);
					tempColor =
						this.LightGroups[Group].autoOnLux.color !== ""
							? this.LightGroups[Group].autoOnLux.color
							: this.LightGroups[Group].color;
					await this.PowerOnAftercare(Group, tempBri, this.LightGroups[Group].ct, tempColor);
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
					this.log.info(`AutoOn_Lux => setting DailyLock to ${this.LightGroups[Group].autoOnLux.dailyLock}`);
				}
			}
		}
	}

	/**
	 * AutoOnMotion
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOnMotion(Group) {
		let tempBri = 0;
		let tempColor = "";

		if (
			!this.LightGroups[Group] ||
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

		const { autoOnMotion, actualLux, isMotion, bri, color, ct } = this.LightGroups[Group] || {};

		if (autoOnMotion?.enabled && actualLux < autoOnMotion?.minLux && isMotion) {
			this.writeLog(`Motion for Group="${Group}" detected, switching on`, "info");
			await this.GroupPowerOnOff(Group, true);

			tempBri = autoOnMotion?.bri !== 0 ? autoOnMotion?.bri : bri || tempBri;
			await this.SetWhiteSubstituteColor(Group);

			tempColor = !autoOnMotion?.color ? autoOnMotion?.color : color || tempColor;
			await this.PowerOnAftercare(Group, tempBri, ct, tempColor);
		}
	}

	/**
	 * AutoOnPresenceIncrease
	 */
	async AutoOnPresenceIncrease() {
		try {
			this.log.debug(`Reaching AutoOnPresenceIncrease`);
			let tempBri = 0;
			let tempColor = "";

			for (const Group in this.LightGroups) {
				if (Group === "All") continue;

				if (
					this.LightGroups[Group].autoOnPresenceIncrease.enabled &&
					this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOnPresenceIncrease.minLux &&
					!this.LightGroups[Group].power
				) {
					await this.GroupPowerOnOff(Group, true);
					tempBri =
						this.LightGroups[Group].autoOnPresenceIncrease.bri !== 0
							? this.LightGroups[Group].autoOnPresenceIncrease.bri
							: this.LightGroups[Group].bri;
					await this.SetWhiteSubstituteColor(Group);
					tempColor =
						this.LightGroups[Group].autoOnPresenceIncrease.color !== ""
							? this.LightGroups[Group].autoOnPresenceIncrease.color
							: (tempColor = this.LightGroups[Group].color);
					await this.PowerOnAftercare(Group, tempBri, this.LightGroups[Group].ct, tempColor);
				}
			}
		} catch (e) {
			this.writeLog(`AutoOnPresenceIncrease => ${e}`, "error");
		}
	}

	/**
	 * Blink
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async blink(Group) {
		try {
			this.setStateAsync(Group + ".blink.enabled", true, true);

			let loopcount = 0;

			//Save actual power state
			await this.SetValueToObject(Group, "blink.actual_power", this.LightGroups[Group].power);

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
							await this.setDeviceBri(Light, this.LightGroups[Group].blink.bri);
					}
				}

				this.LightGroups[Group].power = true;
				await this.setStateAsync(Group + ".power", true, true);

				await this.SetWhiteSubstituteColor(Group);

				if (this.LightGroups[Group].blink.color != "")
					await this.SetColor(Group, this.LightGroups[Group].blink.color);

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

						await this.SetWhiteSubstituteColor(Group);

						if (this.LightGroups[Group].blink.color != "")
							await this.SetColor(Group, this.LightGroups[Group].blink.color);

						this.LightGroups[Group].power = false;
						this.setStateAsync(Group + ".power", false, true);
						//this.SetLightState();
					} else {
						this.writeLog(`Blink => on ${loopcount}`, "info");

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
						await this.SetColor(Group, this.LightGroups[Group].color);
					}
				}
			}, this.LightGroups[Group].blink.frequency * 1000);
		} catch (error) {
			this.errorHandling(error, "blink");
		}
	}

	/**
	 * AutoOffLux
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOffLux(Group) {
		//Handling für AutoOffLux
		try {
			this.writeLog(`[ AutoOffLux ] Reaching for Group="${Group}"`);

			if (
				this.LightGroups[Group].autoOffLux.operator == "<" &&
				this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOffLux.minLux &&
				this.LightGroups[Group].autoOffLux.enabled &&
				this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOffLux.dailyLock
			) {
				await this.GroupPowerOnOff(Group, false);
				this.LightGroups[Group].autoOffLux.dailyLock = true;
				await this.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
			} else if (
				this.LightGroups[Group].autoOffLux.operator == ">" &&
				this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOffLux.minLux &&
				this.LightGroups[Group].autoOffLux.enabled &&
				this.LightGroups[Group].power &&
				!this.LightGroups[Group].autoOffLux.dailyLock
			) {
				await this.GroupPowerOnOff(Group, false);
				this.LightGroups[Group].autoOffLux.dailyLock = true;
				await this.setStateAsync(Group + ".autoOffLux.dailyLock", true, true);
			}

			if (this.LightGroups[Group].autoOffLux.operator == "<") {
				//DailyLock resetten

				if (
					this.LightGroups[Group].actualLux > this.LightGroups[Group].autoOffLux.minLux &&
					this.LightGroups[Group].autoOffLux.dailyLock
				) {
					this.LightGroups[Group].autoOffLux.dailyLockCounter++;

					if (this.LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {
						this.LightGroups[Group].autoOffLux.dailyLock = false;
						await this.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
						this.LightGroups[Group].autoOffLux.dailyLockCounter = 0;
					}
				}
			} else if (this.LightGroups[Group].autoOffLux.operator == ">") {
				if (
					this.LightGroups[Group].actualLux < this.LightGroups[Group].autoOffLux.minLux &&
					this.LightGroups[Group].autoOffLux.dailyLock
				) {
					this.LightGroups[Group].autoOffLux.dailyLockCounter++;

					if (this.LightGroups[Group].autoOffLux.dailyLockCounter >= 5) {
						this.LightGroups[Group].autoOffLux.dailyLock = false;
						await this.setStateAsync(Group + ".autoOffLux.dailyLock", false, true);
						this.LightGroups[Group].autoOffLux.dailyLockCounter = 0;
					}
				}
			}
		} catch (error) {
			this.errorHandling(error, "AutoOffLux", "Group: " + Group);
		}
	}

	/**
	 * AutoOffTimed
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async AutoOffTimed(Group) {
		try {
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
						await this.AutoOffTimed(Group);
					} else {
						this.writeLog(
							`[ AutoOffTimed ] Group="${Group}" timed out, switching off. Motion="${this.LightGroups[Group].isMotion}"`,
						);
						await this.GroupPowerOnOff(Group, false);
					}
				}, Math.round(this.LightGroups[Group].autoOffTimed.autoOffTime) * 1000);
			}
		} catch (error) {
			this.errorHandling(error, "AutoOffTimed", "Group: " + Group);
		}
	}

	/**
	 * SetMasterPower
	 * @param NewVal New Value of state
	 */
	async SetMasterPower(NewVal) {
		const funcName = "SetMasterPower";

		this.writeLog(`[ ${funcName} ] Reaching SetMasterPower`);

		const promises = Object.keys(this.LightGroups)
			.filter((Group) => Group !== "All")
			.map((Group) => {
				this.writeLog(`[ ${funcName} ] Switching Group="${Group}" to ${NewVal}`);
				try {
					return this.setStateAsync(Group + ".power", NewVal, false);
				} catch (error) {
					this.writeLog(`[ ${funcName} ] Not able to set power state of group="${Group}". Error: ${error}`);
				}
			});

		await Promise.all(promises);
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
	async AdaptiveBri(Group) {
		try {
			this.writeLog(
				`[ AdaptiveBri ] Reaching for Group="${Group}" actual Lux="${this.LightGroups[Group].actualLux}" generic lux="${this.ActualGenericLux}`,
			);

			let TempBri = 0;

			if (this.LightGroups[Group].adaptiveBri) {
				if (this.LightGroups[Group].actualLux === 0) {
					TempBri = parseInt(this.Settings.minBri);
				} else if (this.LightGroups[Group].actualLux >= 10000) {
					TempBri = 100;
				} else if (this.LightGroups[Group].actualLux > 0 && this.LightGroups[Group].actualLux < 10000) {
					TempBri = this.LightGroups[Group].actualLux / 100;

					if (TempBri < this.Settings.minBri) TempBri = parseInt(this.Settings.minBri);
				}
			}
			return Math.round(TempBri);
		} catch (error) {
			this.errorHandling(error, "AdaptiveBri");
			return 0;
		}
	}

	/**
	 * SetBrightness
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} Brightness Value 0 to 100
	 * @param {string} [caller="default"] - Quelle des Funktionsaufrufs. Standardmäßig "default"
	 */
	async SetBrightness(Group, Brightness, caller = "default") {
		this.writeLog(
			`[ SetBrightness ] Reaching for Group="${Group}", Brightness="${Brightness}, PowerState="${this.LightGroups[Group].power}"`,
		);

		try {
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
					.map((Light) => this.setDeviceBri(Light, Brightness));

				await Promise.all(promises);
			}

			if (caller === "default") await this.setStateAsync(Group + "." + "bri", Brightness, true);
			return true;
		} catch (error) {
			this.errorHandling(error, "SetBrightness");
		}
	}

	/**
	 * Sets the brightness of a device based on the given `Brightness` parameter and the `minVal` and `maxVal` values from the `Light` object.
	 * @param {object} Light - The Light object containing the device information, including the `minVal` and `maxVal` values for the brightness.
	 * @param {number | undefined} brightness - The brightness value to be set on the device.
	 * @returns {Promise<boolean>} - Returns a Promise that resolves to `true` if the brightness was successfully set, or `false` if there was an error.
	 */
	async setDeviceBri(Light, brightness) {
		try {
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

			const minVal = bri?.minVal || 0;
			const maxVal = bri?.maxVal || 100;
			const defaultBri = bri?.defaultBri || 100;

			const value = Math.round((brightness / 100) * (maxVal - minVal) + minVal);

			await this.setForeignStateAsync(Light.bri.oid, Math.round((value / maxVal) * defaultBri), false);

			return true;
		} catch (error) {
			this.errorHandling(error, "setDeviceBri");
			return false;
		}
	}

	/**
	 * setCt
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} ct
	 */
	async SetCt(Group, ct = this.LightGroups[Group].ct) {
		try {
			if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
				this.writeLog(
					`[ SetCt ] Not able to set Color-Temperature for Group = "${Group}". No lights are defined!!`,
					"warn",
				);
				return;
			}

			this.writeLog(`Reaching SetCt, Group="${Group}" Ct="${this.LightGroups[Group].ct}"`);

			await Promise.all(
				this.LightGroups[Group].lights.map(async (Light) => {
					const { ct, color } = Light ?? {};
					if ((this.LightGroups[Group].power || ct?.sendCt) && ct?.oid) {
						const outMinCt = ct?.minVal ?? 0;
						const outMaxCt = ct?.maxVal ?? 100;
						const CtReverse = ct?.CtReverse ?? false;
						await this.setForeignStateAsync(
							ct.oid,
							await this.KelvinToRange(outMinCt, outMaxCt, ct, CtReverse),
							false,
						);
					}
					if ((this.LightGroups[Group].power || color?.sendCt) && color?.oid && color?.setCtwithColor) {
						await this.SetWhiteSubstituteColor(Group);
					}
				}),
			);

			await this.setStateAsync(Group + ".ct", ct, true);

			return true;
		} catch (error) {
			this.errorHandling(error, "SetCt");
		}
	}

	/**
	 * KelvinToRange
	 * @param {number} outMinCt	minimum Ct-Value of target state
	 * @param {number} outMaxCt	maximum Ct-Value of target state
	 * @param {number} kelvin	kelvin value of group (e.g. 2700)
	 * @param {boolean} CtReverse	switch if lower ct-value is cold
	 * @returns {Promise<number>} return the Ct-Value of the target state
	 */
	async KelvinToRange(outMinCt, outMaxCt, kelvin, CtReverse = false) {
		try {
			const minCt = this.Settings.minCt || 2700;
			const maxCt = this.Settings.maxCt || 6500;
			let rangeValue;

			kelvin = Math.min(Math.max(kelvin, minCt), maxCt); // constrain kelvin to minCt and maxCt

			if (CtReverse) {
				rangeValue = ((maxCt - kelvin) / (maxCt - minCt)) * (outMaxCt - outMinCt) + outMinCt;
			} else {
				rangeValue = ((kelvin - minCt) / (maxCt - minCt)) * (outMaxCt - outMinCt) + outMinCt;
			}
			return Math.round(Math.min(Math.max(rangeValue, outMinCt), outMaxCt)); // constrain the range to outMinCt and outMaxCt
		} catch (error) {
			this.errorHandling(
				error,
				"KelvinToRange",
				`kelvin: ${kelvin}, outMaxCt: ${outMaxCt}, outMinCt: ${outMinCt}`,
			);
			return -1;
		}
	}

	/**
	 * AdapticeCt
	 */
	async AdaptiveCt() {
		try {
			const now = new Date();
			const ActualTime = now.getTime();

			const minCt = this.Settings.minCt;
			const maxCt = this.Settings.maxCt;
			const CtRange = maxCt - minCt;

			this.writeLog(`[ AdaptiveCt ] minCT="${minCt}", maxCt="${maxCt}", CtRange="${CtRange}"`);

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
				`[ AdaptiveCt // getAstroDate] sunsetDate="${sunsetDate}", sunriseDate="${sunriseDate}", solarNoonDate="${solarNoonDate}"`,
			);

			if (sunsetDate instanceof Date && sunriseDate instanceof Date && solarNoonDate instanceof Date) {
				sunset = sunsetDate.getTime(); //Sonnenuntergang
				sunrise = sunriseDate.getTime(); //Sonnenaufgang
				solarNoon = solarNoonDate.getTime(); //Höchster Sonnenstand (Mittag)
			} else {
				this.writeLog(`[ AdaptiveCt ] sunsetDate, sunriseDate or solarNoonDate are no Date Objects"`, "warn");
				return;
			}

			this.writeLog(
				`[ AdaptiveCt ] minCT="${minCt}", maxCt="${maxCt}", sunset="${sunset}", sunrise="${sunrise}", solarNoon="${solarNoon}"`,
			);

			let morningTime = 0;

			const sunMinutesDay = (sunset - sunrise) / 1000 / 60;
			const RangePerMinute = CtRange / sunMinutesDay;

			const sunpos = SunCalc.getPosition(now, this.lat, this.lng);
			const sunposNoon = SunCalc.getPosition(solarNoon, this.lat, this.lng);

			if (await compareTime(this, sunrise, solarNoon, "between", ActualTime)) {
				//   log("Aufsteigend")
				adaptiveCtLinear = Math.round(minCt + ((ActualTime - sunrise) / 1000 / 60) * RangePerMinute * 2); // Linear = ansteigende Rampe von Sonnenaufgang bis Sonnenmittag, danach abfallend bis Sonnenuntergang
			} else if (await compareTime(this, solarNoon, sunset, "between", ActualTime)) {
				//   log("Absteigend")
				adaptiveCtLinear = Math.round(maxCt - ((ActualTime - solarNoon) / 1000 / 60) * RangePerMinute * 2);
			}

			if (await compareTime(this, sunrise, sunset, "between", ActualTime)) {
				adaptiveCtSolar = Math.round(minCt + sunMinutesDay * RangePerMinute * sunpos.altitude); // Solar = Sinusrampe entsprechend direkter Elevation, max Ct differiert nach Jahreszeiten
				adaptiveCtSolarInterpolated = Math.round(
					minCt + sunMinutesDay * RangePerMinute * sunpos.altitude * (1 / sunposNoon.altitude),
				); // SolarInterpolated = Wie Solar, jedoch wird der Wert so hochgerechnet dass immer zum Sonnenmittag maxCt gesetzt wird, unabhängig der Jahreszeit
			}

			this.writeLog(`[ AdaptiveCt ] adaptiveCtLinear="${adaptiveCtLinear}" adaptiveCtSolar="${adaptiveCtSolar}"`);

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
						if (
							this.LightGroups[Group].adaptiveCt?.enabled &&
							this.LightGroups[Group].ct !== adaptiveCtSolar
						) {
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
						if (
							this.LightGroups[Group].adaptiveCt?.enabled &&
							this.LightGroups[Group].ct !== adaptiveCtTimed
						) {
							morningTime = (
								await getDateObject(this.LightGroups[Group].adaptiveCt?.adaptiveCtTime)
							).getTime();
							if (ActualTime >= morningTime && ActualTime <= sunset) {
								adaptiveCtTimed = Math.round(
									maxCt + ((minCt - maxCt) * (ActualTime - morningTime)) / (sunset - morningTime),
								);
							} else {
								adaptiveCtTimed = minCt;
							}

							this.writeLog(
								`[ AdaptiveCt // timed ] morningTime="${this.LightGroups[Group].adaptiveCt?.adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimed}"`,
							);

							await this.setStateAsync(Group + ".ct", adaptiveCtTimed, false);
						}
						break;
					case "timedInterpolated":
						if (
							this.LightGroups[Group].adaptiveCt?.enabled &&
							this.LightGroups[Group].ct !== adaptiveCtTimedInterpolated
						) {
							morningTime = (
								await getDateObject(this.LightGroups[Group].adaptiveCt?.adaptiveCtTime)
							).getTime();

							if (ActualTime >= morningTime && ActualTime <= sunset) {
								const base = 2;
								const timeFraction = (ActualTime - morningTime) / (sunset - morningTime);
								const exponentialValue = Math.pow(base, timeFraction);
								adaptiveCtTimedInterpolated = Math.round(
									await this.mapping(exponentialValue, 1, base, maxCt, minCt),
								);
							} else {
								adaptiveCtTimedInterpolated = minCt;
							}

							this.writeLog(
								`[ AdaptiveCt // timedInterpolated ] morningTime="${this.LightGroups[Group].adaptiveCt?.adaptiveCtTime}" => "${morningTime}", ActualTime="${ActualTime}", sunset="${sunset}", adativeCtTimed="${adaptiveCtTimedInterpolated}"`,
							);

							await this.setStateAsync(Group + ".ct", adaptiveCtTimedInterpolated, false);
						}
						break;
				}
			}

			//Timeout 60s to restart function
			if (this.TickerIntervall) clearTimeout(this.TickerIntervall);

			this.TickerIntervall = setTimeout(() => {
				this.AdaptiveCt();
			}, 60000);
		} catch (error) {
			this.errorHandling(error, "AdaptiveCt");
		}
	}

	/**
	 * Maps a value from one range to another range.
	 * @param {number} value - The value to map to the new range.
	 * @param {number} minInput - The minimum value of the input range.
	 * @param {number} maxInput - The maximum value of the input range.
	 * @param {number} minOutput - The minimum value of the output range.
	 * @param {number} maxOutput - The maximum value of the output range.
	 * @returns {Promise<number>} - The mapped value.
	 */

	async mapping(value, minInput, maxInput, minOutput, maxOutput) {
		return ((value - minInput) * (maxOutput - minOutput)) / (maxInput - minInput) + minOutput;
	}

	/**
	 * SetWhiteSubstituteColor
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async SetWhiteSubstituteColor(Group) {
		try {
			if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
				this.writeLog(
					`[ SetWhiteSubstituteColor ] Not able to set white substitute color for Group = "${Group}". No lights are defined!!`,
					"warn",
				);
				return;
			}

			const minCt = this.Settings.minCt;
			const maxCt = this.Settings.maxCt;

			this.writeLog(
				`[ SetWhiteSubstituteColor ] Reaching for Group="${Group}" = "${this.LightGroups[Group].description}" LightGroups[Group].power="${this.LightGroups[Group].power}" LightGroups[Group].color="${this.LightGroups[Group].color}`,
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
					const colorValue = colorConv.ConvertKelvinToHue(this.LightGroups[Group].ct);
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
					const colorValue = colorConv.convertKelvinToRGB(this.LightGroups[Group].ct);
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
					const rgb = colorConv.convertKelvinToRGB(this.LightGroups[Group].ct);
					const colorValue = colorConv.ConvertRgbToXy(rgb);
					await this.setForeignStateAsync(Light.color.oid, { val: JSON.stringify(colorValue), ack: false });
				});

			await Promise.all([
				promisesWarmWhiteDayLight,
				promisesKelvinWithHUE,
				promisesKelvinWithRGB,
				promisesKelvinWithXY,
			]);
		} catch (error) {
			this.errorHandling(error, "SetWhiteSubstituteColor");
		}
	}

	/**
	 * SetColorMode
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 */
	async SetColorMode(Group) {
		try {
			if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
				this.writeLog(
					`[ SetColorMode ] Not able to set color mode for Group = "${Group}". No lights are defined!!`,
					"warn",
				);
				return;
			}

			this.writeLog(`[ SetColorMode ] Reaching for Group="${Group}"`, "info");

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
							this.writeLog(`[ SetColorMode ] Device="${Light.modeswitch.oid}" to whiteMode`, "info"),
						]);
					} else {
						// bei allen anderen Farben
						await Promise.all([
							this.setForeignStateAsync(Light.modeswitch.oid, Light.modeswitch.colorModeVal, false),
							this.writeLog(`[ SetColorMode ] Device="${Light.modeswitch.oid}" to colorMode`, "info"),
						]);
					}
				});

			await Promise.all(promises);

			return true;
		} catch (error) {
			this.errorHandling(error, "SetColorMode");
		}
	}

	/**
	 * SetColor
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {any} Color
	 */
	async SetColor(Group, Color) {
		try {
			if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
				this.writeLog(
					`[ SetWhiteSubstituteColor ] Not able to set color for Group = "${Group}". No lights are defined!!`,
					"warn",
				);
				return;
			}
			this.writeLog(
				`[ SetColor ] Reaching for Group="${Group}" power="${this.LightGroups[Group].power}" Color="${Color}"`,
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
								const rgbTemp = colorConv.ConvertHexToRgb(Color);
								await this.setForeignStateAsync(Light.color.oid, {
									val: JSON.stringify(rgbTemp),
									ack: false,
								});
								break;
							}
							case "xy": {
								const rgbTemp = colorConv.ConvertHexToRgb(Color);
								const XyTemp = colorConv.ConvertRgbToXy(rgbTemp);
								await this.setForeignStateAsync(Light.color.oid, {
									val: JSON.stringify(XyTemp),
									ack: false,
								});
								break;
							}
							case "hue": {
								if (Light.bri?.oid && Light.sat?.oid) {
									const colorValue = colorConv.ConvertHexToHue(Color);
									await Promise.all([
										this.setForeignStateAsync(Light.color.oid, colorValue.hue, false),
										this.setForeignStateAsync(Light.sat.oid, colorValue.saturation, false),
										this.setForeignStateAsync(Light.bri.oid, colorValue.brightness, false),
									]);
								} else {
									await this.writeLog(
										`[ SetColor ] Set color with HUE is not possible, because brightness or saturation state is not defined!`,
										"warn",
									);
								}
								break;
							}
							default:
								await this.writeLog(
									`[ SetColor ] Unknown colorType = "${Light.color.colorType}" in Group="${Group}", please specify!`,
									"warn",
								);
						}
					}
				});

			await Promise.all(promises);

			await this.setStateAsync(Group + ".color", this.LightGroups[Group].color, true);
			return true;
		} catch (error) {
			this.errorHandling(error, "SetColor", JSON.stringify(this.LightGroups[Group].color));
		}
	}

	/**
	 * SetTt
	 * @description Set transmission time to lights
	 * @async
	 * @function
	 * @param {object} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} RampTime Information about the RampTime in milliseconds
	 * @param {string} prop rampUp, rampDown or standard
	 */
	async SetTt(Group, RampTime, prop) {
		try {
			if (!this.LightGroups[Group] || !this.LightGroups[Group].lights || !this.LightGroups[Group].lights.length) {
				this.writeLog(
					`[ SetTt] Not able to set transition time for Group = "${Group}". No lights are defined!!`,
					"warn",
				);
				return;
			}
			this.writeLog(`[ SetTt ] Reaching for Group="${Group}", TransitionTime="${RampTime}ms"`);

			const promises = this.LightGroups[Group].lights
				.filter((Light) => Light.tt?.oid)
				.map(async (Light) => {
					const tt = await convertTime(Light.tt.unit, RampTime);
					await Promise.all([
						this.setForeignStateAsync(Light.tt.oid, { val: tt, ack: false }),
						this.writeLog(`[ SetTt ] Set ${Light.description} (${Light.tt.oid}) to: ${tt}${Light.tt.unit}`),
					]);
				});

			await Promise.all(promises);

			await this.setStateAsync(Group + "." + prop, RampTime, true);
			return true;
		} catch (error) {
			this.errorHandling(error, "SetTt", `RampTime: ${RampTime}, Prop: ${prop}`);
		}
	}

	/**
	 * PowerOnAftercare
	 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
	 * @param {number} bri Brighness 0 - 100 %
	 * @param {number} ct Color-Temperatur Kelvin
	 * @param {string} color Color HEX value
	 */
	async PowerOnAftercare(
		Group,
		bri = this.LightGroups[Group].bri,
		ct = this.LightGroups[Group].ct,
		color = this.LightGroups[Group].color,
	) {
		try {
			this.writeLog(
				`[ PowerOnAfterCare ] Reaching for Group="${Group}" bri="${bri}" ct="${ct}" color="${color}"`,
				"info",
			);

			if (this.LightGroups[Group].power) {
				//Nur bei anschalten ausführen

				if (!this.LightGroups[Group].rampOn.enabled) {
					//Wenn kein RampOn Helligkeit direkt setzen

					if (this.LightGroups[Group].adaptiveBri) {
						//Bei aktiviertem AdaptiveBri
						await this.SetBrightness(Group, await this.AdaptiveBri(Group));
					} else {
						this.writeLog(`[ PowerOnAfterCare ] Now setting bri to ${bri}% for Group="${Group}"`, "info");
						await this.SetBrightness(Group, bri);
					}
				}

				await this.SetColor(Group, color); //Nach anschalten Color setzen

				if (color == "#FFFFFF") await this.SetWhiteSubstituteColor(Group);

				await this.SetColorMode(Group); //Nach anschalten Colormode setzen

				if (color == "#FFFFFF") await this.SetCt(Group, ct); //Nach anschalten Ct setzen
			}
		} catch (error) {
			this.errorHandling(error, "PowerOnAftercare");
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
	async Init() {
		this.writeLog(`Init is starting...`, "info");
		if (this.DevMode) await this.TestStatesCreate;
		await this.GlobalLuxHandling();
		await this.GlobalPresenceHandling();
		await this.StatesCreate();
		const latlng = await this.GetSystemData();
		if (latlng) await this.AdaptiveCt();
		this.writeLog(`Init finished.`, "info");
	}

	/**
	 * Create LightGroups Object
	 * @description Creates Object LightGroups from system.config array
	 */
	async CreateLightGroupsObject() {
		try {
			const { Settings } = this;
			const { LightGroups } = Settings;

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
				this.writeLog(`[ CreateLightGroupsObject ] LightGroups: ${JSON.stringify(this.LightGroups)}`);
			} else {
				this.writeLog(`[ CreateLightGroupsObject ] No LightGroups defined in instance settings!`, "warn");
			}
		} catch (error) {
			this.errorHandling(error, "CreateLightGroupsObject");
		}
	}

	/**
	 * GlobalLuxHandling
	 * @description If a global lux sensor has been defined, its value is written to the global variable and the state is subscribed.
	 */
	async GlobalLuxHandling() {
		try {
			const { Settings } = this;
			const { GlobalLuxSensor } = Settings;
			this.ActualGenericLux = 0;

			if (!GlobalLuxSensor) {
				return;
			}

			const actualGenericLux = await this.getForeignStateAsync(GlobalLuxSensor);
			const _actualGenericLux = await helper.checkObjectNumber(actualGenericLux);

			if (_actualGenericLux !== null) {
				this.log.warn(
					`[ GlobalLuxHandling ] state value of id="${GlobalLuxSensor}" is empty, null, undefined, or not a valid number!`,
				);
				return;
			}

			this.ActualGenericLux = _actualGenericLux;
			await this.subscribeForeignStatesAsync(GlobalLuxSensor);
			this.LuxSensors.push(GlobalLuxSensor);
		} catch (error) {
			this.errorHandling(error, "GlobalLuxHandling");
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
		try {
			const luxSensor = this.LightGroups[Group].LuxSensor || this.Settings.GlobalLuxSensor;
			this.LightGroups[Group].actualLux = 0;

			if (!luxSensor) {
				this.writeLog(
					`[ DoAllTheLuxSensorThings ] No Luxsensor for Group="${Group}" defined, set actualLux = 0, skip handling`,
				);
				return;
			}

			if (luxSensor === this.Settings.GlobalLuxSensor) {
				this.LightGroups[Group].actualLux = this.ActualGenericLux ?? null;
				this.LightGroups[Group].LuxSensor = luxSensor;
				this.writeLog(`[ DoAllTheLuxSensorThings ] Group "${Group}" using global luxsensor.`);
				return;
			}

			const individualLux = await this.getForeignStateAsync(luxSensor);
			const _individualLux = await helper.checkObjectNumber(individualLux);

			if (_individualLux !== null) {
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
		} catch (error) {
			this.errorHandling(error, "DoAllTheLuxSensorThings");
		}
	}

	/**
	 * GlobalPresenceHandling
	 */
	async GlobalPresenceHandling() {
		try {
			if (this.Settings.PresenceCountDp) {
				this.writeLog(`[ GlobalPresenceHandling ] PresenceCounteDp=${this.Settings.PresenceCountDp}`);
				this.ActualPresenceCount = { newVal: 0, oldVal: 0 };

				const ActualPresenceCount = await this.getForeignStateAsync(this.Settings.PresenceCountDp);
				const _ActualPresenceCount = await helper.checkObjectNumber(ActualPresenceCount);

				if (_ActualPresenceCount !== null) {
					this.log.warn(
						`[ GlobalPresenceHandling ] state value of id="${this.Settings.PresenceCountDp}" is empty, null or undefined!`,
					);
					return;
				}

				this.ActualPresenceCount = { newVal: _ActualPresenceCount, oldVal: 0 };
				this.ActualPresence = this.ActualPresenceCount.newVal === 0 ? false : true;
				await this.subscribeForeignStatesAsync(this.Settings.PresenceCountDp);
			}

			if (this.Settings.IsPresenceDp) {
				this.writeLog(`[ GlobalPresenceHandling ] IsPresenceDp=${this.Settings.IsPresenceDp}`);
				this.ActualPresence = false;

				const ActualPresence = await this.getForeignStateAsync(this.Settings.IsPresenceDp);
				const _ActualPresence = await helper.checkObjectBoolean(ActualPresence);

				if (_ActualPresence === null) {
					this.writeLog(
						`[ GlobalPresenceHandling ] isPresenceDp=${this.Settings.IsPresenceDp} is not type="boolean"!`,
						"warn",
					);
					return;
				}

				this.ActualPresence = _ActualPresence;
				await this.subscribeForeignStatesAsync(this.Settings.IsPresenceDp);
			}
		} catch (error) {
			this.errorHandling(error, "GlobalPresenceHandling");
		}
	}

	/**
	 * State create, extend objects and subscribe states
	 */
	async StatesCreate() {
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
						const dp = Group + "." + prop1 + "." + key;
						const common = DeviceTemplate[prop1][key];

						await this.CreateStates(dp, common);
						keepStates.push(dp);

						try {
							const state = await this.getStateAsync(dp);

							if (!state) {
								this.writeLog(
									`[ StatesCreate ] State: "${dp}" is NULL or undefined! Init aborted!`,
									"warn",
								);
								return;
							}

							await this.SetValueToObject(Group, prop1, state.val);
							common.write && (await this.subscribeStatesAsync(dp));
						} catch (error) {
							this.writeLog(
								`[ StatesCreate ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
								"warn",
							);
							return;
						}
					}
				} else {
					const common = DeviceTemplate[prop1];
					await this.CreateStates(dp, common);
					keepStates.push(dp);

					try {
						const state = await this.getStateAsync(dp);

						if (!state) {
							this.writeLog(
								`[ StatesCreate ] State: "${dp}" is NULL or undefined! Init aborted!`,
								"warn",
							);
							return;
						}

						if (prop1 === "power") {
							this.writeLog(
								`[ StatesCreate ] Group="${Group}", Prop1="${prop1}", powerNewVal="${state.val}"`,
							);
							await this.SetValueToObject(Group, "powerNewVal", state.val);
						}

						if (state) {
							await this.SetValueToObject(Group, prop1, state.val);
						}

						common.write && (await this.subscribeStatesAsync(dp));
					} catch (error) {
						this.writeLog(
							`[ StatesCreate ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
							"warn",
						);
						return;
					}
				}
			}
			await this.SetValueToObject(Group, ["autoOnLux.dailyLockCounter", "autoOffLux.dailyLockCounter"], 0);
		}

		//Create All-Channel if not exists
		await this.CreateDevice("All", "Controll all groups together");
		keepDevices.push("All");

		for (const prop1 in DeviceAllTemplate) {
			const dp = "All." + prop1;
			const common = DeviceAllTemplate[prop1];

			await this.CreateStates(dp, common);
			keepStates.push(dp);

			try {
				const state = await this.getStateAsync(dp);

				if (!state) {
					this.writeLog(`[ StateCreate ] State: "${dp}" is NULL or undefined! Init aborted`, "warn");
					return;
				}

				if (prop1 === "power") {
					this.writeLog(`[ StateCreate ] Group="All", Prop1="${prop1}", powerNewVal="${state.val}"`);
					await this.SetValueToObject("All", "powerNewVal", state.val);
				}

				await this.SetValueToObject("All", dp, state.val);

				common.write && (await this.subscribeStatesAsync(dp));
			} catch (error) {
				this.writeLog(
					`[ StatesCreate ] not able to getState of id="${dp}". Please check your config! Init aborted! Error: ${error}`,
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
					const id = await helper.removeNamespace(this.namespace, objects[o]._id);

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
			this.writeLog(`[ StatesCreate ] not able to getObjects! Init aborted! Error: ${error}`, "warn");
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
	async TestStatesCreate() {
		this.writeLog("[ TestStatesCreate ]Creating Test devices...");

		const userdata = "0_userdata.0.lightcontrol_DEV.";

		//Loop TestLamps and create datapoints to 0_userdata.0
		for (const Lamp in TestTemplateLamps) {
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

			for (const prop1 in TestTemplateLamps[Lamp]) {
				const common = TestTemplateLamps[Lamp][prop1];
				const dp = userdata + "Lamps." + Lamp + "." + prop1;
				await this.CreateStates(dp, common, true);
			}
		}

		//Loop Test Motion Sensors and create datapoints to 0_userdata.0
		for (const MotionSensor in TestTemplateMotionSensors) {
			const common = TestTemplateMotionSensors[MotionSensor];
			const dp = userdata + "MotionSensors." + MotionSensor;
			await this.CreateStates(dp, common, true);
		}

		//Loop Test Lux Sensors and create datapoints to 0_userdata.0
		for (const LuxSensor in TestTemplateLuxSensors) {
			const common = TestTemplateLuxSensors[LuxSensor];
			const dp = userdata + "LuxSensors." + LuxSensor;
			await this.CreateStates(dp, common, true);
		}

		//Loop Test Presence and create datapoints to 0_userdata.0
		for (const Presence in TestTemplatePresence) {
			const common = TestTemplatePresence[Presence];
			const dp = userdata + "Presence." + Presence;
			await this.CreateStates(dp, common, true);
		}
	}

	/**
	 * Create datapoint and extend datapoints
	 * @author Schmakus
	 * @async
	 * @param {string} dp path to datapoint
	 * @param {ioBroker.StateCommon} common type of datapoint, e.g. string, number, boolean, ...
	 * @param {boolean} [foreign = false] set adapter states = false; set foreign states = true
	 */
	async CreateStates(dp, common, foreign) {
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
				this.writeLog(`[ CreateStates ] State: ${dp} created.`);
			} else {
				if (JSON.stringify(obj.common) !== JSON.stringify(common) || !("native" in obj)) {
					obj.common = common;
					obj.native = obj.native ?? {};
					await (foreign ? this.setForeignObjectAsync(dp, obj) : this.setObjectAsync(dp, obj));
				}
			}
		} catch (error) {
			this.writeLog(`[ CreateStates ] Not able create state or getObject (${dp}). Error: ${error}`, "warn");
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
	 * @description Init all Custom states
	 */
	async InitCustomStates() {
		try {
			// Get all objects with custom configuration items
			const customStateArray = await this.getObjectViewAsync("system", "custom", {});
			this.writeLog(`[ InitCustomStates ] All states with custom items : ${JSON.stringify(customStateArray)}`);

			// List all states with custom configuration
			if (customStateArray && customStateArray.rows) {
				// Verify first if result is not empty

				// Loop truth all states and check if state is activated for LightControl
				for (const index in customStateArray.rows) {
					if (customStateArray.rows[index].value) {
						// Avoid crash if object is null or empty

						// Check if custom object contains data for LightControl
						// @ts-ignore
						if (customStateArray.rows[index].value[this.namespace]) {
							this.writeLog(`[ InitCustomStates ] LightControl configuration found`);

							// Simplify stateID
							const stateID = customStateArray.rows[index].id;

							//Check if its an own Lightcontrol State
							if (stateID.includes(this.namespace)) {
								await this.deaktivateOwnId(stateID);
								continue;
							}

							// Check if custom object is enabled for LightControl
							// @ts-ignore
							if (customStateArray.rows[index].value[this.namespace].enabled) {
								if (!this.activeStates.includes(stateID)) this.activeStates.push(stateID);
								this.writeLog(`[ InitCustomStates ] LightControl enabled state found ${stateID}`);
							} else {
								this.writeLog(
									`[ InitCustomStates ] LightControl configuration found but not Enabled, skipping ${stateID}`,
								);
							}
						}
					}
				}
			}

			const totalEnabledStates = this.activeStates.length;
			let totalInitiatedStates = 0;
			let totalFailedStates = 0;
			this.writeLog(`Found ${totalEnabledStates} LightControl enabled states`, "info");

			// Initialize all discovered states
			let count = 1;
			for (const stateID of this.activeStates) {
				this.writeLog(`[ InitCustomStates ] Initialising (${count} of ${totalEnabledStates}) "${stateID}"`);
				await this.buildLightGroupParameter(stateID);

				if (this.activeStates.includes(stateID)) {
					totalInitiatedStates = totalInitiatedStates + 1;
					this.writeLog(`Initialization of ${stateID} successfully`, "info");
				} else {
					this.writeLog(
						`[ InitCustomStates ] Initialization of ${stateID} failed, check warn messages !`,
						"warn",
					);
					totalFailedStates = totalFailedStates + 1;
				}
				count = count + 1;
			}

			// Subscribe on all foreign objects to detect (de)activation of LightControl enabled states
			await this.subscribeForeignObjectsAsync("*");
			this.writeLog(
				`[ InitCustomStates ] subscribed all foreign objects to detect (de)activation of LightControl enabled states`,
			);

			if (totalFailedStates > 0) {
				this.writeLog(
					`[ InitCustomStates ] Cannot handle calculations for ${totalFailedStates} of ${totalEnabledStates} enabled states, check error messages`,
					"warn",
				);
			}

			this.writeLog(
				`Successfully activated LightControl for ${totalInitiatedStates} of ${totalEnabledStates} states, will do my Job until you stop me!`,
				"info",
			);
		} catch (error) {
			this.errorHandling(error, "InitCustomStates");
		}
	}

	/**
	 * Load state definitions to memory this.activeStates[stateID]
	 * @param {string} stateID ID  of state to refresh memory values
	 */
	async buildLightGroupParameter(stateID) {
		this.writeLog(`[ buildStateDetailsArray ] started for ${stateID}`);
		try {
			let stateInfo;
			try {
				// Load configuration as provided in object
				/** @type {ioBroker.StateObject} */
				stateInfo = await this.getForeignObjectAsync(stateID);

				if (!stateInfo) {
					this.writeLog(
						`[ buildStateDetailsArray ] Can't get information for ${stateID}, state will be ignored`,
						"warn",
					);
					this.activeStates = await helper.removeValue(this.activeStates, stateID);
					this.unsubscribeForeignStates(stateID);
					return;
				}
			} catch (error) {
				this.writeLog(
					`[ buildStateDetailsArray ] ${stateID} is incorrectly correctly formatted, ${JSON.stringify(
						error,
					)}`,
					"error",
				);
				this.activeStates = await helper.removeValue(this.activeStates, stateID);
				this.unsubscribeForeignStates(stateID);
				return;
			}

			// Check if configuration for LightControl is present, trow error in case of issue in configuration
			if (stateInfo && stateInfo.common && stateInfo.common.custom && stateInfo.common.custom[this.namespace]) {
				const customData = stateInfo.common.custom[this.namespace];

				const LightGroup = this.LightGroups[customData.group];

				//Check if a Groupname defined
				if (!customData.group) {
					this.writeLog(
						`[ buildStateDetailsArray ] No Group Name defined for StateID: ${stateID}. Initalisation aborted`,
						"warn",
					);
					return;
				}

				//Check if a Group in LightGroups is available or deleted by user
				if (!LightGroup) {
					//If checkbox for removing lights and sensor setting is acitaved in instance settings
					if (this.Settings.deleteUnusedConfig) {
						this.writeLog(
							`[ buildStateDetailsArray ] Light group "${customData.group}" was deleted by the user in the instance settings! LightControl settings will be deactivated for this StateID: ${stateID})`,
							"warn",
						);
						this.writeLog(
							`[ buildStateDetailsArray ] Object before deactivating: ${JSON.stringify(stateInfo)}`,
						);

						stateInfo.common.custom[this.namespace].enabled = false;

						this.writeLog(
							`[ buildStateDetailsArray ] Object after deactivating: ${JSON.stringify(stateInfo)}`,
						);

						await this.setForeignObjectAsync(stateID, stateInfo);
					} else {
						this.writeLog(
							`[ buildStateDetailsArray ] Light group "${customData.group}" was deleted by the user in the instance settings! (StateID: ${stateID})`,
							"warn",
						);
					}

					return;
				}

				//const commonData = stateInfo.common;
				this.writeLog(`[ buildLightGroupParameter ] customData ${JSON.stringify(customData)}`);

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

				//Add Id to custom data
				customData.oid = stateID;
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
								`[ buildStateDetailsArray ] No Lightname defined. Initalisiation aborted`,
								"warn",
							);
							return;
						}

						if (LightGroup.lights && Array.isArray(LightGroup.lights)) {
							const Lights = LightGroup.lights;

							// Überprüfen, ob jedes Objekt eine description-Eigenschaft hat
							const allObjectsHaveDescription = Lights.every(
								(x) => x && typeof x.description === "string",
							);

							if (allObjectsHaveDescription) {
								///Find index in Lights Array if description available
								const index = Lights.findIndex((x) => x.description === customData.description);

								let Light;

								if (await helper.isNegative(index)) {
									Light = Lights.length === 0 ? (Lights[0] = {}) : (Lights[Lights.length] = {});
								} else {
									Light = Lights[index];
								}

								// Add parameters to Light
								Light.description = customData.description;
								Light[customData.func] = getSubset(customData, ...params[customData.func]);

								this.writeLog(
									`[ buildStateDetailsArray ] Type: Light, in Group: ${
										LightGroup.description
									} with Lights: ${JSON.stringify(Lights)} and Light: ${JSON.stringify(
										Light,
									)} with Index: ${index}`,
								);
							} else {
								this.writeLog(
									`[ buildStateDetailsArray ] Any Light of Group=${LightGroup.description} has no own description. Init aborted`,
									"warn",
								);
							}
						} else {
							this.errorHandling(
								`Any Light has no description. Init aborted. No Index found`,
								"buildStateDetailsArray",
								JSON.stringify(LightGroup.lights),
							);
							return;
						}

						break;
					}
					case "sensor": {
						this.writeLog(`[ buildStateDetailsArray ] Type: Sensor in Group ${LightGroup.description}}`);
						const Sensors = LightGroup.sensors;
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
				if (!this.activeStates.includes(stateID)) this.activeStates.push(stateID);

				this.writeLog(`[ buildStateDetailsArray ] completed for ${stateID}.`);
				this.writeLog(`[ buildStateDetailsArray ] Updated LightGroups: ${JSON.stringify(this.LightGroups)}`);
			}
		} catch (error) {
			this.errorHandling(error, "buildStateDetailsArray");
		}
	}

	/**
	 * SummarizeSensors
	 * @param {string} Group
	 */
	async SummarizeSensors(Group) {
		try {
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
				await this.Controller(Group, "isMotion", this.LightGroups[Group].isMotion, Motionstate);
			} else {
				this.writeLog(
					`[ SummarizeSensors ] Motionstate="${Group}" = ${Motionstate}, nothing changed -> nothin to do`,
				);
			}
		} catch (error) {
			this.errorHandling(error, "SummarizeSensors");
		}
	}

	/**
	 * Get System Longitude and Latitute
	 */
	async GetSystemData() {
		try {
			const obj = await this.getForeignObjectAsync("system.config");

			if (obj && obj.common && obj.common.longitude && obj.common.latitude) {
				this.lng = obj.common.longitude;
				this.lat = obj.common.latitude;

				this.writeLog(`[ GetSystemData ] longitude: ${this.lng} | latitude: ${this.lat}`);
			} else {
				this.writeLog(
					"system settings cannot be called up (Longitute, Latitude). Please check your ioBroker configuration!",
					"warn",
				);
			}
			return true;
		} catch (error) {
			this.errorHandling(error, "GetSystemData");
			return false;
		}
		//}
	}

	/**
	 * Set anyOn and Masterswitch Light State
	 * @param {string} from From which Function?
	 */
	async SetLightState(from = "noFunction") {
		try {
			const countGroups = await this.countGroups();
			const groupLength = Object.keys(this.LightGroups).length - 1;

			await Promise.all([
				helper.SetValueToObject(this.LightGroups, "All.anyOn", countGroups > 0),
				helper.SetValueToObject(this.LightGroups, "All.power", countGroups === groupLength),
			]);

			await Promise.all([
				this.setStateAsync("All.anyOn", this.LightGroups.All.anyOn, true),
				this.setStateAsync("All.power", this.LightGroups.All.power, true),
			]);
			this.writeLog(
				`[ SetLightState ] Set State "All.anyOn" to ${this.LightGroups.All.anyOn} from function="${from}"`,
			);
		} catch (error) {
			this.errorHandling(error, "SetLightState");
		}
	}

	/**
	 * Helper: count Power in Groups
	 * @async
	 * @function
	 * @returns {Promise<number>}
	 */
	async countGroups() {
		try {
			let i = 0;
			for (const Group in this.LightGroups) {
				if (Group === "All") continue;

				if (this.LightGroups[Group].power) {
					i++;
				}
			}
			return i;
		} catch (error) {
			this.errorHandling(error, "countGroups");
			return 0;
		}
	}

	/**
	 * deaktivate state id because it's an own lightcontrol id
	 * @async
	 * @param {string} stateID ID of the Object
	 * @returns {Promise<boolean>}
	 */
	async deaktivateOwnId(stateID) {
		this.writeLog(
			`[ InitCustomStates ] This Object-ID: "${stateID}" is not allowed, because it's an LightControl State! The settings will be deaktivated automatically!`,
			"warn",
		);
		try {
			const stateInfo = await this.getForeignObjectAsync(stateID);
			if (stateInfo?.common?.custom) {
				stateInfo.common.custom[this.namespace].enabled = false;
				await this.setForeignObjectAsync(stateID, stateInfo);
			}
			return true;
		} catch (error) {
			this.errorHandling(error, "deaktivateOwnId", stateID);
			return false;
		}
	}

	/**
	 * deleteStateIdFromLightGroups
	 * @param {string} stateID ID of the Object
	 */
	async deleteStateIdFromLightGroups(stateID) {
		try {
			// Loop trough LighGroups and delete Object by oid value
			const keys = ["power", "bri", "ct", "sat", "color", "modeswitch"];
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
		} catch (error) {
			this.errorHandling(error, "deleteStateIdFromLightGroups");
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

	async SetValueToObject(Group, key, value) {
		if (Object.prototype.hasOwnProperty.call(this.LightGroups, Group)) {
			this.log.warn(`[ SetValueToObject ] Group="${Group}" is not in LightGroups object!`);
			return;
		}

		const group = this.LightGroups[Group];
		if (Array.isArray(key)) {
			if (Array.isArray(value) && key.length === value.length) {
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
					currentObj[lastKey] = value[index];
				});
			} else {
				this.log.warn(
					`[ SetValueToObject ] Error: The length of the value array does not match the length of the key array."`,
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
	}

	/**
	 * a function for log output
	 * @async
	 * @function
	 * @param {string} logtext
	 * @param {string} logtype ("silly" | "info" | "debug" | "warn" | "error")
	 * @param {string} funcName Extended info. Example the name of the function
	 * @return {Promise<void>}
	 */
	async writeLog(logtext, logtype = "debug", funcName = "") {
		try {
			const logFunctions = {
				silly: this.log.silly,
				info: this.log.info,
				debug: this.log.debug,
				warn: this.log.warn,
				error: this.log.error,
			};
			const logFn = logFunctions[logtype];
			if (logFn) {
				logFn(`${funcName ? "[ " + funcName + " ] " : ""} ${logtext}`);
			}
		} catch (error) {
			this.log.error(`[ writeLog ] error: ${error}`);
		}
	}

	/**
	 * Error Handling
	 * @param {object} error error message from catch block
	 * @param {string} codePart described the code part or function
	 * @param {string} extended extended info about the error
	 */
	async errorHandling(error, codePart, extended = "") {
		try {
			this.writeLog(
				`error: ${error.message} // stack: ${error.stack} ${extended ? " // extended info: " + extended : ""}`,
				"error",
				codePart,
			);
			if (!disableSentry) {
				if (this.supportsFeature && this.supportsFeature("PLUGINS")) {
					const sentryInstance = this.getPluginInstance("sentry");
					if (sentryInstance) {
						const Sentry = sentryInstance.getSentryObject();
						if (Sentry)
							Sentry.captureException(
								`[ v${this.version} ${codePart} ] ${error} // extended info: ${extended} )}`,
							);
					}
				}
			}
		} catch (error) {
			this.writeLog(`[ errorHandling ] error: ${error}`, "error");
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
