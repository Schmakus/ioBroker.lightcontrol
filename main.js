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
const { params } = require("./lib/params");
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
		this.GlobalSettings = this.config;
		this.Settings = this.config;
		this.writeLog(`[ onReady ] LightGroups from Settings: ${JSON.stringify(this.Settings.LightGroups)}`);

		//Create LightGroups Object from GroupNames
		await init.CreateLightGroupsObject(this);
		await this.log.debug(JSON.stringify(this.LightGroups));

		//Create all States, Devices and Channels
		if (Object.keys(this.LightGroups).length !== 0) {
			await init.Init(this);
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
			timers.clearRampOnIntervals(this, null);
			timers.clearRampOffIntervals(this, null);
			timers.clearBlinkIntervals(this, null);
			timers.clearAutoOffTimeouts(this, null);
			this.clearTimeout(this.TickerIntervall);

			callback();
		} catch (error) {
			this.errorHandling(error, "onUnload");
			callback();
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
								this.writeLog(
									`[ onObjectChange ] Updating LightControl configuration for : ${stateID}`,
								);
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
					this.processing = false;
				} else {
					// Object change not related to this adapter, ignoring
				}
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

						const OwnId = await helper.removeNamespace(this, id);
						const { Group, Prop } = await helper.ExtractGroupAndProp(OwnId);

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
							await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));

							//Check if it's Presence Counter
						} else if (this.Settings.PresenceCountDp === id) {
							this.writeLog(`[ onStateChange ] It's PresenceCountDp: ${id}`);

							this.ActualPresenceCount.oldVal = this.ActualPresenceCount.newVal;
							this.ActualPresenceCount.newVal = typeof state.val === "number" ? state.val : 0;

							if (this.ActualPresenceCount.newVal > this.ActualPresenceCount.oldVal) {
								this.writeLog(
									`[ onStateChange ] PresenceCountDp value is greater than old value: ${state.val}`,
								);
								await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));
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

						await init.DoAllTheMotionSensorThings(this, customData.group);

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

			this.writeLog(
				`[ Controller ] Reaching, Group="${Group}" Property="${prop1}" NewVal="${NewVal}", ${
					OldVal === undefined ? "" : "OldVal=" + OldVal
				}"`,
				"info",
			);

			if (prop1 !== "power") await helper.SetValueToObject(LightGroups[Group], prop1, NewVal);

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
				case "autoOnLux.operator":
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
				case "adaptiveCt.enabled":
					//await lightHandling.SetCt(this, Group, LightGroups[Group].ct);
					//handeled = true;
					break;
				case "adaptiveCt.adaptiveCtMode":
					break;
				case "adaptiveCt.adaptiveCtTime":
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
				case "transitionTime":
					await lightHandling.SetTt(this, Group, await helper.limitNumber(NewVal, 0, 64000), prop1);
					handeled = true;
					break;
				case "power":
					if (NewVal !== OldVal) {
						await switchingOnOff.GroupPowerOnOff(this, Group, NewVal); //Alles schalten
						if (NewVal) await lightHandling.PowerOnAftercare(this, Group);
						if (!NewVal && LightGroups[Group].autoOffTimed.enabled) {
							//Wenn ausschalten und autoOffTimed ist aktiv, dieses löschen, da sonst erneute ausschaltung nach Ablauf der Zeit. Ist zusätzlich rampon aktiv, führt dieses zu einem einschalten mit sofort folgenden ausschalten
							await timers.clearAutoOffTimeouts(this, Group);
						}
						if (!NewVal && LightGroups[Group].powerCleaningLight) {
							//Wenn via Cleaninglight angeschaltet wurde, jetzt aber normal ausgeschaltet, powerCleaningLight synchen um Blockade der Autofunktionen zu vermeiden
							LightGroups[Group].powerCleaningLight = false;
							await this.setStateAsync(Group + ".powerCleaningLight", false, true);
						}
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
					this.writeLog(`[ Controller ] Error, unknown or missing property: "${prop1}"`, "warn");
					handeled = true;
			}

			if (!handeled) {
				if (id !== "") {
					await this.setStateAsync(id, NewVal, true);
				}
			}
		} catch (error) {
			this.errorHandling(error, "Controller");
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
