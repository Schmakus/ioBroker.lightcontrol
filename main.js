"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require("@iobroker/adapter-core");

// eslint-disable-next-line no-unused-vars
const helper = require("./lib/helper");
const timers = require("./lib/timers");
const switchingOnOff = require("./lib/switchingOnOff");
const lightHandling = require("./lib/lightHandling");
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
		await this.CreateLightGroupsObject();
		await this.writeLog(JSON.stringify(this.LightGroups));

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
			timers.clearRampIntervals(this, null);
			timers.clearTransitionTimeout(this, null);
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
	 * State create, extend objects and subscribe states
	 */
	async Init() {
		this.writeLog(`Init is starting...`, "info");
		if (this.DevMode) await this.TestStatesCreate;
		await this.GlobalLuxHandling();
		await this.GlobalPresenceHandling();
		await this.StatesCreate();
		const latlng = await this.GetSystemData();
		if (latlng) lightHandling.AdaptiveCt(this);
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
		try {
			this.writeLog(`[ DoAllTheMotionSensorThings ] Reaching, Group = "${Group}`);

			for (const sensor of this.LightGroups[Group].sensors) {
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
			}
		} catch (error) {
			this.errorHandling(error, "DoAllTheMotionSensorThings");
		}
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
					const id = await helper.removeNamespace(this, objects[o]._id);

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
			return true;
		} catch (error) {
			this.errorHandling(error, "Controller");
			return false;
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
