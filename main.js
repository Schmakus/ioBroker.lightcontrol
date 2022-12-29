"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require("@iobroker/adapter-core");
// eslint-disable-next-line no-unused-vars
const helper = require("./lib/helper");
const init = require("./lib/init");
const timers = require("./lib/timers");
const switchingOnOff = require("./lib/switchingOnOff");
const lightHandling = require("./lib/lightHandling");

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
		this.GlobalSettings = {};
		this.LightGroups = {};
		this.LuxSensors = [];
		this.MotionSensors = [];

		this.activeStates = []; // Array of activated states for LightControl

		this.ActualGenericLux = 0;
		this.ActualPresence = true;
		this.ActualPresenceCount = { newVal: 1, oldVal: 1 };

		this.RampOnIntervalObject = {};
		this.RampOffIntervalObject = {};
		this.AutoOffTimeoutObject = {};
		this.AutoOffNoticeTimeoutObject = {};

		this.TickerIntervall = null;
		this.BlinkIntervalObj = {};

		this.lat = "";
		this.lng = "";

		this.DevMode = false;
		this.processing = false;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		// Reset the connection indicator during startup
		//this.setState("info.connection", false, true);

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.GlobalSettings = this.config;
		this.Settings = this.config;
		if (this.Settings.debug) this.writeLog("Raw LightGroups: " + JSON.stringify(this.Settings.LightGroups));

		//Create LightGroups Object from GroupNames
		await this.CreateLightGroupsObject();

		//Init all Objects with custom config
		await this.InitCustomStates();

		//Create all States, Devices and Channels
		await init.Init(this);
		if (this.Settings.debug) this.log.debug(JSON.stringify(this.LightGroups));

		//Get Latitude and Longitude
		await this.GetSystemData().catch((e) => this.log.error(`onRready // GetSystemData => ${e}`));

		//Set LightState
		this.SetLightState().catch((e) => this.log.error(`onRready // SetLightState => ${e}`));

		//this.setState("info.connection", true, true);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			timers.clearRampOnIntervals(this, null);
			timers.clearRampOffIntervals(this, null);
			timers.clearBlinkIntervals(this, null);
			timers.clearAutoOffTimeouts(this, null);
			this.clearTimeout(this.TickerIntervall);

			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Create LightGroups Object
	 * @description Creates Object LightGroups from system.config array
	 */
	async CreateLightGroupsObject() {
		try {
			for (const Groups of this.Settings.LightGroups) {
				let _temp;
				for (const [key, value] of Object.entries(Groups)) {
					if (key === "Group") {
						this.LightGroups[value] = {};
						this.LightGroups[value].description = value;
						_temp = value;
					} else if (key === "GroupLuxSensor") {
						this.LightGroups[_temp].LuxSensor = value;
						this.LightGroups[_temp].lights = [];
						this.LightGroups[_temp].sensors = [];
					}
				}
			}
		} catch (e) {
			this.writeLog(`CreateLightGroupsObject => Error: ${e}`, "error");
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
			if (!this.processing) {
				this.processing = true;
				const stateID = id;

				// Check if object is activated for LightControl
				if (obj && obj.common) {
					// Verify if custom information is available regarding LightControl
					if (
						obj.common.custom &&
						obj.common.custom[this.namespace] &&
						obj.common.custom[this.namespace].enabled
					) {
						this.writeLog(
							`onObjectChange => Object array of LightControl activated state changed : ${JSON.stringify(
								obj,
							)} stored Objects : ${JSON.stringify(this.activeStates)}`,
						);

						// Verify if the object was already activated, if not initialize new parameter
						if (!this.activeStates.includes(stateID)) {
							this.writeLog(`onObjectChange => Enable LightControl for : ${stateID}`, "info");
							await this.buildLightGroupParameter(stateID);

							if (!this.activeStates.includes(stateID)) {
								this.writeLog(
									`onObjectChange => Cannot enable LightControl for ${stateID}, check settings and error messages`,
									"warn",
								);
							}
						} else {
							this.writeLog(`onObjectChange => Updating LightControl configuration for : ${stateID}`);
							//Cleaning LightGroups from ID and set it new
							await this.deleteStateIdFromLightGroups(stateID);
							await this.buildLightGroupParameter(stateID);

							if (!this.activeStates.includes(stateID)) {
								this.writeLog(
									`onObjectChange => Cannot update LightControl configuration for ${stateID}, check settings and error messages`,
									"warn",
								);
							}
						}
					} else if (this.activeStates.includes(stateID)) {
						this.activeStates = await helper.removeValue(this.activeStates, stateID);
						this.writeLog(`onObjectChange => Disabled LightControl for : ${stateID}`, "info");

						await this.deleteStateIdFromLightGroups(stateID);

						this.writeLog(
							`onObjectChange => Active state array after deactivation of ${stateID} : ${
								this.activeStates.length === 0 ? "empty" : JSON.stringify(this.activeStates)
							}`,
						);
						this.writeLog(
							`onObjectChange => LightGroups after deactivation of ${stateID} : ${JSON.stringify(
								this.LightGroups,
							)}`,
						);
						this.unsubscribeForeignStates(stateID);
					}
					this.processing = false;
				} else {
					// Object change not related to this adapter, ignoring
				}
			}
		} catch (e) {
			this.writeLog(`onObjectChange =>  ${e}`, "error");
		}
	}

	/**
	 * Is called if a message is comming
	 */
	async onMessage(msg) {
		this.writeLog(`onMessage => Incomming Message from: ${JSON.stringify(msg)}`);
		if (msg.callback) {
			try {
				switch (msg.command) {
					case "LightGroup": {
						const groups = [];
						for (const Group in this.LightGroups) {
							// iterate through all existing groups and extract group names
							if (Group === "All") continue;
							groups.push({ value: Group, label: Group });
						}
						this.sendTo(msg.from, msg.command, groups, msg.callback);
						this.writeLog(`onMessage => LightGroup => LightGroups Callback: ${JSON.stringify(groups)}.`);
						break;
					}

					case "LightName": {
						const LightGroups = msg.message.LightGroups;
						this.writeLog(`onMessage => LightName => getLights for Groups: ${LightGroups}.`);
						const lights = [];
						if (LightGroups) {
							for (const light of Object.values(this.LightGroups[LightGroups].lights)) {
								lights.push({ value: light.description, label: light.description });
								this.writeLog(
									`onMessage => LightName => Light: ${light.description} in Group: ${LightGroups} found.`,
								);
							}
						}

						if (!lights.length) lights.push({ value: "Example_Light", label: "Example_Light" });
						this.sendTo(msg.from, msg.command, lights, msg.callback);
						break;
					}

					case "id": {
						const value = msg.message.value;
						this.writeLog(`onMessage => id => Set new ID. Value = ${value}.`);
						if (msg.message.value !== null) {
							this.sendTo(msg.from, msg.command, value, msg.callback);
						} else {
							const oldID = this.config._id;
							const newID = oldID + 1;

							await this.extendForeignObjectAsync("system.adapter." + this.namespace, {
								native: { _id: newID },
							});

							this.writeLog(`onMessage => id => Set new ID. OldID = ${oldID}, NewID = ${newID}`);
							this.sendTo(msg.from, msg.command, newID.toString(), msg.callback);
						}
						break;
					}

					case "checkIdForDuplicates": {
						this.writeLog(`onMessage => checkcheckIdForDuplicates`);
						this.writeLog(JSON.stringify(msg.message));

						const LightGroups = msg.message.LightGroups;

						const arr = [];
						for (const Group of LightGroups) {
							arr.push(Group.Group);
						}
						this.writeLog(`onMessage => checkcheckIdForDuplicates: ${arr}`);

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
							this.writeLog(`onMessage => checkcheckIdForDuplicates: No duplicates.`);
							this.sendTo(msg.from, msg.command, "", msg.callback);
						} else {
							this.writeLog(
								`Define LightGroups => checkcheckIdForDuplicates: Duplicate GroupNames found.`,
								"warn",
							);
							this.sendTo(msg.from, msg.command, "labelDuplicateGroup", msg.callback);
						}
						break;
					}
				}
			} catch (e) {
				this.log.error(`onMessage => ${e}`);
			}
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
				this.log.debug(`onStateChange => state ${id} changed: ${state.val} (ack = ${state.ack})`);

				if (ids[0] == "lightcontrol") {
					if (!state.ack) {
						const NewVal = state.val;
						let OldVal;

						this.log.debug(`onStateChange => InternalState`);
						const _state = await helper.CheckInputGeneral(this, id, state);
						this.log.debug(
							`onStateChange => CheckInputGeneral for ${id} with state: ${NewVal} is: ${_state}`,
						);

						const OwnId = await helper.removeNamespace(this, id);
						const Group = (await helper.ExtractGroupAndProp(OwnId)).Group;
						const Prop = (await helper.ExtractGroupAndProp(OwnId)).Prop;

						if (Prop === "power" && Group !== "All") {
							OldVal = this.LightGroups[Group].powerOldVal = this.LightGroups[Group].powerNewVal;
							this.LightGroups[Group].powerNewVal = NewVal;
						}

						if (Group === "All") {
							await switchingOnOff.SetMasterPower(this, NewVal);
						} else {
							await this.Controller(Group, Prop, NewVal, OldVal, OwnId);
						}
					}
				} else {
					//Handle External States
					if (state.ack || !state.ack) {
						this.log.debug(`onStateChange => ExternalState`);

						//Check if it's a LuxSensor
						if (this.LuxSensors.includes(id)) {
							for (const Group in this.LightGroups) {
								if (this.LightGroups[Group].LuxSensor === id) {
									if (state.val !== this.LightGroups[Group].actualLux) {
										this.log.debug(
											`onStateChange => It's a LuxSensor in following Group: ${Group}`,
										);
										this.LightGroups[Group].actualLux = state.val;
										await this.Controller(
											Group,
											"actualLux",
											state.val,
											this.LightGroups[Group].actualLux,
											"",
										);
									}
								}
							}

							//Check if it's a MotionSensor
						} else if (this.MotionSensors.includes(id)) {
							for (const Group in this.LightGroups) {
								if (Group === "All") continue;

								for (const Sensor in this.LightGroups[Group].sensors) {
									if (this.LightGroups[Group].sensors[Sensor].oid === id) {
										this.log.debug(
											`onStateChange => It's a MotionSensor in following Group: ${Group}`,
										);

										if (state.val === this.LightGroups[Group].sensors[Sensor].motionVal) {
											//Inhalt lesen und neues Property anlegen und füllen
											this.LightGroups[Group].sensors[Sensor].isMotion = true;
											this.log.debug(
												`onStateChange => Sensor="${Sensor}" in Group="${Group}". This isMotion="true"`,
											);
										} else {
											this.LightGroups[Group].sensors[Sensor].isMotion = false;
											this.log.debug(
												`onStateChange => Sensor="${Sensor}" in Group="${Group}". This isMotion="false"`,
											);
										}

										await this.SummarizeSensors(Group).catch((e) => this.log.error(e));
									}
								}
							}

							//Check if it's Presence
						} else if (this.GlobalSettings.IsPresenceDp === id) {
							this.log.debug(`onStateChange => It's IsPresenceDp: ${id}`);

							this.ActualPresence = typeof state.val === "boolean" ? state.val : false;
							await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));

							//Check if it's Presence Counter
						} else if (this.GlobalSettings.PresenceCountDp === id) {
							this.log.debug(`onStateChange => It's PresenceCountDp: ${id}`);

							this.ActualPresenceCount.oldVal = this.ActualPresenceCount.newVal;
							this.ActualPresenceCount.newVal = typeof state.val === "number" ? state.val : 0;

							if (this.ActualPresenceCount.newVal > this.ActualPresenceCount.oldVal) {
								this.log.debug(
									`onStateChange => PresenceCountDp value is greater than old value: ${state.val}`,
								);
								await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));
							}
						}
					}
				}
			} else {
				// The state was deleted
				this.log.debug(`onStateChange => state ${id} deleted`);
			}
		} catch (e) {
			this.log.error(`onStateChange => ${e}`);
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
			this.writeLog(`InitCustomStates => All states with custom items : ${JSON.stringify(customStateArray)}`);

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
							this.writeLog(`InitCustomStates => LightControl configuration found`);

							// Simplify stateID
							const stateID = customStateArray.rows[index].id;

							// Check if custom object is enabled for LightControl
							// @ts-ignore
							if (customStateArray.rows[index].value[this.namespace].enabled) {
								if (!this.activeStates.includes(stateID)) this.activeStates.push(stateID);
								this.writeLog(`InitCustomStates => LightControl enabled state found ${stateID}`);
							} else {
								this.writeLog(
									`InitCustomStates => LightControl configuration found but not Enabled, skipping ${stateID}`,
								);
							}
						} else {
							console.log(`InitCustomStates => No LightControl configuration found`);
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
				this.writeLog(`InitCustomStates => Initialising (${count} of ${totalEnabledStates}) "${stateID}"`);
				await this.buildLightGroupParameter(stateID);

				if (this.activeStates.includes(stateID)) {
					totalInitiatedStates = totalInitiatedStates + 1;
					this.writeLog(`InitCustomStates => Initialization of ${stateID} successfully`, "info");
				} else {
					this.writeLog(
						`InitCustomStates => Initialization of ${stateID} failed, check warn messages !`,
						"error",
					);
					totalFailedStates = totalFailedStates + 1;
				}
				count = count + 1;
			}

			// Subscribe on all foreign objects to detect (de)activation of LightControl enabled states
			await this.subscribeForeignObjectsAsync("*");
			this.writeLog(
				`InitCustomStates => subscribed all foreign objects to detect (de)activation of LightControl enabled states`,
			);

			if (totalFailedStates > 0) {
				this.writeLog(
					`Cannot handle calculations for ${totalFailedStates} of ${totalEnabledStates} enabled states, check error messages`,
					"warn",
				);
			}

			this.writeLog(
				`Successfully activated LightControl for ${totalInitiatedStates} of ${totalEnabledStates} states, will do my Job until you stop me!`,
				"info",
			);
		} catch (e) {
			this.writeLog(
				`GlobalPresenceHandling: Object-ID "this.GlobalSettings.PresenceCounterDp" not exits. Please check your config! (${e})`,
				"error",
			);
		}
	}

	/**
	 * Load state definitions to memory this.activeStates[stateID]
	 * @param {string} stateID ID  of state to refresh memory values
	 */
	async buildLightGroupParameter(stateID) {
		this.writeLog(`buildLightGroupParameter => started for ${stateID}`);
		try {
			let stateInfo;
			try {
				// Load configuration as provided in object
				stateInfo = await this.getForeignObjectAsync(stateID);
				if (!stateInfo) {
					this.writeLog(
						`buildLightGroupParameter => Can't get information for ${stateID}, state will be ignored`,
						"error",
					);
					this.activeStates = await helper.removeValue(this.activeStates, stateID);
					this.unsubscribeForeignStates(stateID);
					return;
				}
			} catch (error) {
				this.writeLog(
					`buildLightGroupParameter => ${stateID} is incorrectly correctly formatted, ${JSON.stringify(
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
						`buildStateDetailsArray => No Group Name defined for StateID: ${stateID}. Initalisation aborted`,
						"warn",
					);
					return;
				}

				//Check if a Group in LightGroups is available
				if (!LightGroup) {
					this.writeLog(
						`buildStateDetailsArray => LightGroup ${customData.group} in StateID: ${stateID} not defined in LightGroups`,
						"warn",
					);
					return;
				}

				//const commonData = stateInfo.common;
				this.writeLog(`buildLightGroupParameter => customData ${JSON.stringify(customData)}`);

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
				const params = {
					bri: ["oid", "minVal", "maxVal", "defaultBri", "sendBri"],
					power: ["oid", "onVal", "offVal"],
					ct: ["oid", "minVal", "maxVal", "sendCt"],
					sat: ["oid", "minVal", "maxVal", "sendCt"],
					modeswitch: ["oid", "whiteModeVal", "colorModeVal", "sendModeswitch"],
					color: ["oid", "colorType", "defaultColor", "sendColor"],
				};

				/*
				CustomData Example
				{
						"enabled": true,
						"defaultBri": "100",
						"whiteModeVal": "false",
						"colorModeVal": "true",
						"colorType": "rgb",
						"type": "light",
						"func": "ct",
						"onVal": 1,
						"offVal": 0,
						"minVal": 450,
						"maxVal": 252,
						"motionVal": true,
						"noMotionVal": false,
						"group": "Wohnzimmer",
						"description": "Example_Light",
						"sendCt": true,
						"sendSat": true,
						"sendColor": true,
						"sendModeswitch": true,
						"useBri": true
					}
				*/

				// Function to reduce the customData
				const getSubset = (obj, ...keys) => keys.reduce((a, c) => ({ ...a, [c]: obj[c] }), {});

				switch (customData.type) {
					case "light": {
						//Check if a Lightname is available
						if (!customData.description) {
							this.writeLog(
								`buildStateDetailsArray => No Lightname defined. Initalisiation aborted`,
								"warn",
							);
							return;
						}
						const Lights = LightGroup.lights;

						//Find index in Lights Array if description available
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
							`buildStateDetailsArray => Type: Light, in Group: ${
								LightGroup.description
							} with Lights: ${JSON.stringify(Lights)} and Light: ${JSON.stringify(
								Light,
							)} with Index: ${index}`,
						);

						break;
					}
					case "sensor": {
						const Sensors = LightGroup.sensors;
						Sensors.push({
							oid: customData.oid,
							motionVal: customData.motionVal,
							noMotionVal: customData.noMotionVal,
						});

						await init.DoAllTheMotionSensorThings(this, customData.group);

						this.writeLog(
							`buildStateDetailsArray => Type: Sensor, in Group Object: ${JSON.stringify(LightGroup)}`,
						);
						break;
					}
					default:
						break;
				}

				//Push stateID after processing
				if (!this.activeStates.includes(stateID)) this.activeStates.push(stateID);

				this.writeLog(`buildStateDetailsArray => completed for ${stateID}.`);
				if (this.GlobalSettings.debug) this.writeLog(JSON.stringify(this.LightGroups));
			}
		} catch (error) {
			this.writeLog(`buildStateDetailsArray => ${stateID} => ${error}`, "error");
		}
	}

	/**
	 * Is called from onStateChange
	 * @param {string} Group Any Group of Lightgroups
	 * @param {string} prop1 Which State has changed
	 * @param {any} NewVal New Value of Datapoint
	 * @param {any} OldVal Old Value of Datapoint
	 * @param {string} id Object-ID
	 */
	async Controller(Group, prop1, NewVal, OldVal, id = "") {
		//Used by all
		try {
			const LightGroups = this.LightGroups;
			let handeled = false;

			this.log.info(
				`Reaching Controller, Group="${Group}" Property="${prop1}" NewVal="${NewVal}", OldVal="${
					OldVal === undefined ? "" : OldVal
				}"`,
			);

			await helper.SetValueToObject(LightGroups[Group], prop1, NewVal);

			switch (prop1) {
				case "actualLux":
					if (!LightGroups[Group].powerCleaningLight) {
						//Autofunktionen nur wenn Putzlicht nicht aktiv
						await switchingOnOff.AutoOnLux(this, Group);
						await switchingOnOff.AutoOffLux(this, Group);
						if (this.LightGroups[Group].adaptiveBri)
							await lightHandling.SetBrightness(
								this,
								Group,
								await lightHandling.AdaptiveBri(this, Group),
							);
						await switchingOnOff.AutoOnMotion(this, Group);
					}
					handeled = true;
					break;
				case "isMotion":
					if (!this.LightGroups[Group].powerCleaningLight) {
						if (LightGroups[Group].isMotion && LightGroups[Group].power) {
							//AutoOff Timer wird nach jeder Bewegung neugestartet
							//this.log.info(`Controller: Motion detected, restarting AutoOff Timer for Group="${Group}"`);
							await switchingOnOff.AutoOffTimed(this, Group);
						}

						await switchingOnOff.AutoOnMotion(this, Group);
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
					await switchingOnOff.AutoOffLux(this, Group);
					handeled = true;
					break;
				case "autoOnLux.enabled":
					break;
				case "autoOnLux.switchOnlyWhenNoPresence":
					break;
				case "autoOnLux.switchOnlyWhenPresence":
					break;
				case "autoOnLux.minLux":
					break;
				case "autoOnLux.bri":
					switchingOnOff.AutoOnLux(this, Group);
					handeled = true;
					break;
				case "autoOnPresenceIncrease.enabled":
					break;
				case "autoOnPresenceIncrease.bri":
					break;
				case "autoOnPresenceIncrease.color":
					break;
				case "autoOnPresenceIncrease.minLux":
					await switchingOnOff.AutoOnPresenceIncrease(this);
					handeled = true;
					break;
				case "bri":
					await lightHandling.SetBrightness(this, Group, LightGroups[Group].bri);
					handeled = true;
					break;
				case "ct":
					await lightHandling.SetCt(this, Group, LightGroups[Group].ct);
					await lightHandling.SetWhiteSubstituteColor(this, Group);
					handeled = true;
					break;
				case "color":
					// @ts-ignore
					if (await helper.CheckHex(NewVal)) {
						// @ts-ignore
						LightGroups[Group].color = NewVal.toUpperCase();
						await lightHandling.SetColor(this, Group, LightGroups[Group].color);
						if (LightGroups[Group].color == "#FFFFFF")
							await lightHandling.SetWhiteSubstituteColor(this, Group);
						await lightHandling.SetColorMode(this, Group);
					}
					handeled = true;
					break;
				case "power":
					if (NewVal !== OldVal) {
						await switchingOnOff.GroupPowerOnOff(this, Group, NewVal); //Alles schalten
						await lightHandling.PowerOnAftercare(this, Group);
						if (!NewVal && LightGroups[Group].autoOffTimed.enabled) {
							//Wenn ausschalten und autoOffTimed ist aktiv, dieses löschen, da sonst erneute ausschaltung nach Ablauf der Zeit. Ist zusätzlich rampon aktiv, führt dieses zu einem einschalten mit sofort folgenden ausschalten
							await timers.clearAutoOffTimeouts(this, Group);
						}
						if (!NewVal && LightGroups[Group].powerCleaningLight) {
							//Wenn via Cleaninglight angeschaltet wurde, jetzt aber normal ausgeschaltet, powerCleaningLight synchen um Blockade der Autofunktionen zu vermeiden
							LightGroups[Group].powerCleaningLight = false;
							await this.setStateAsync(Group + ".powerCleaningLight", false, true);
						}
					} else {
						await timers.clearAutoOffTimeouts(this, Group);
						await switchingOnOff.SimpleGroupPowerOnOff(this, Group, NewVal);
					}

					handeled = true;
					break;
				case "powerCleaningLight":
					await switchingOnOff.GroupPowerCleaningLightOnOff(this, Group, NewVal);
					handeled = true;
					break;
				case "adaptiveBri":
					await lightHandling.SetBrightness(this, Group, await lightHandling.AdaptiveBri(this, Group));
					handeled = true;
					break;
				case "adaptiveCt":
					await lightHandling.SetCt(this, Group, LightGroups[Group].ct);
					handeled = true;
					break;
				case "adaptiveCtMode":
					break;
				case "adaptiveCtTime":
					break;
				case "dimmUp":
					await this.setStateAsync(
						Group + "." + "bri",
						Math.min(Math.max(LightGroups[Group].bri + LightGroups[Group].dimmAmount, 10), 100),
						false,
					);
					handeled = true;
					break;
				case "dimmDown":
					await this.setStateAsync(
						Group + "." + "bri",
						Math.min(Math.max(LightGroups[Group].bri - LightGroups[Group].dimmAmount, 2), 100),
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
						await helper.SetValueToObject(LightGroups[Group], "blink.infinite", true);
						await helper.SetValueToObject(LightGroups[Group], "blink.stop", false);
						await switchingOnOff.blink(this, Group);
					} else if (!NewVal) {
						await helper.SetValueToObject(LightGroups[Group], "blink.stop", true);
					}
					handeled = true;
					break;
				case "blink.start":
					await helper.SetValueToObject(LightGroups[Group], ["blink.stop", "blink.infinite"], false);
					await switchingOnOff.blink(this, Group);
					break;
				default:
					this.log.error(`Controller => Error, unknown or missing property: "${prop1}"`);
					handeled = true;
			}

			if (!handeled) {
				if (id !== "") {
					await this.setStateAsync(id, NewVal, true);
				}
			}
		} catch (e) {
			this.log.error(`Controller => ${e}`);
		}
	}

	/**
	 * SummarizeSensors
	 * @param {string} Group
	 */
	async SummarizeSensors(Group) {
		try {
			this.log.debug(`Reaching SummarizeSensors, Group="${Group}"`);

			let Motionstate = false;

			for (const Sensor in this.LightGroups[Group].sensors) {
				if (this.LightGroups[Group].sensors[Sensor].isMotion) {
					this.log.debug(
						`SummarizeSensors => Group="${Group}" Sensor="${Sensor}" with target ${this.LightGroups[Group].sensors[Sensor].oid} has value ${this.LightGroups[Group].sensors[Sensor].isMotion}`,
					);
					Motionstate = true;
				}
			}

			if (this.LightGroups[Group].isMotion !== Motionstate) {
				this.log.debug(
					`SummarizeSensors => Summarized IsMotion for Group="${Group}" = ${Motionstate}, go to Controller...`,
				);
				this.LightGroups[Group].isMotion = Motionstate;
				await this.setStateAsync(Group + ".isMotion", Motionstate, true);
				await this.Controller(Group, "isMotion", this.LightGroups[Group].isMotion, Motionstate);
			} else {
				this.log.debug(
					`SummarizeSensors => No Motionstate="${Group}" = ${Motionstate}, nothing changed -> nothin to do`,
				);
			}
		} catch (e) {
			this.log.error(`SummarizeSensors => ${e}`);
		}
	}

	/**
	 * Get System Longitude and Latitute
	 */
	async GetSystemData() {
		try {
			const obj = await this.getForeignObjectAsync("system.config", "state");

			if (obj && obj.common && obj.common.longitude && obj.common.latitude) {
				this.lng = obj.common.longitude;
				this.lat = obj.common.latitude;

				this.log.debug(`GetSystemData => longitude: ${this.lng} | latitude: ${this.lat}`);
			} else {
				this.log.error(
					"system settings cannot be called up (Longitute, Latitude). Please check your ioBroker configuration!",
				);
			}
		} catch (e) {
			this.log.error(
				`GetSystemData => system settings 'Latitude and Longitude' cannot be called up. Please check configuration!`,
			);
		}
		//}
	}

	/**
	 * Set anyOn and Masterswitch Light State
	 */
	async SetLightState() {
		try {
			this.log.debug("Reaching SetLightState: anyOn and Masterswitch");
			const groupLength = Object.keys(this.LightGroups).length - 1;
			const countGroups = await this.countGroups();

			await helper.SetValueToObject(this.LightGroups, "All.anyOn", countGroups > 0 ? true : false);
			await helper.SetValueToObject(this.LightGroups, "All.power", countGroups === groupLength ? true : false);
			await this.setStateAsync("All.anyOn", this.LightGroups.All.anyOn, true);
			this.log.debug(`SetLightState => Set State "All.anyOn" to ${this.LightGroups.All.anyOn}`);
			await this.setStateAsync("All.power", this.LightGroups.All.power, true);
		} catch (e) {
			this.log.error(`SetLightState => ${e}`);
		}
	}

	/**
	 * Helper: count Power in Groups
	 */
	async countGroups() {
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
	 * deleteStateIdFromLightGroups
	 * @param {string} stateID ID of the Object
	 */
	async deleteStateIdFromLightGroups(stateID) {
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
									`deleteStateIdFromLightGroups => ID = ${stateID} will delete in Group = "${this.LightGroups[Groups].description}", Param = ${key}`,
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
							`deleteStateIdFromLightGroups => Light: ${lightArray[i].description} will be deleted, because no Object-IDs are defined.`,
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
						`onObjectChange => Sensor with ID = ${stateID} will delete in Group = "${this.LightGroups[Groups].description}"`,
						"info",
					);
				}
			}
		}
	}

	/**
	 * a function for log output
	 * @param {string} logtext
	 * @param {string} logtype ('silly' | 'info' | 'debug' | 'warn' | 'error')
	 */
	async writeLog(logtext, logtype = "debug") {
		try {
			if (logtype === "silly") this.log.silly(logtext);
			if (logtype === "info") this.log.info(logtext);
			if (logtype === "debug") this.log.debug(logtext);
			if (logtype === "warn") this.log.warn(logtext);
			if (logtype === "error") this.log.error(logtext);
		} catch (error) {
			this.log.error(`writeLog error => ${error} , stack: ${error.stack}`);
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
