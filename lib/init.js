"use strict";

const helper = require("./helper");
const { DeviceTemplate, DeviceAllTemplate } = require(`./groupTemplates`);
const lightHandling = require("./lightHandling");

const {
	TestTemplateLamps,
	TestTemplateMotionSensors,
	TestTemplateLuxSensors,
	TestTemplatePresence,
} = require(`./testTemplates`);

/**
 * State create, extend objects and subscribe states
 * @param adapter
 */
async function Init(adapter) {
	adapter.writeLog(`Init is starting...`, "info");
	if (adapter.DevMode) await TestStatesCreate(adapter);
	await GlobalLuxHandling(adapter);
	await GlobalPresenceHandling(adapter);
	await StatesCreate(adapter);
	const latlng = await adapter.GetSystemData();
	if (latlng) lightHandling.AdaptiveCt(adapter);
	adapter.writeLog(`Init finished.`, "info");
	adapter.writeLog(`Init => Created LightGroups Memory: ${JSON.stringify(adapter.LightGroups)}`);
}

/**
 * Create LightGroups Object
 * @description Creates Object LightGroups from system.config array
 */
async function CreateLightGroupsObject(adapter) {
	try {
		if (adapter.Settings.LightGroups && adapter.Settings.LightGroups.length) {
			adapter.writeLog(`[ CreateLightGroupsObject ] LightGroups are defined in instance settings`);
			const regex = /^[a-zA-Z0-9_-]*$/; // Regulärer Ausdruck zur Überprüfung von erlaubten Zeichen
			adapter.Settings.LightGroups.forEach(({ Group, GroupLuxSensor }) => {
				if (!regex.test(Group)) {
					// Überprüfen, ob "Group" nur erlaubte Zeichen enthält
					adapter.writeLog(
						`[ CreateLightGroupsObject ] Group "${Group}" contains invalid characters. Please update the group name in instance setting. Skipping...`,
						"warn",
					);
					return; // Überspringen des Loops, wenn "Group" ungültige Zeichen enthält
				}
				adapter.LightGroups[Group] = {
					description: Group,
					LuxSensor: GroupLuxSensor,
					lights: [],
					sensors: [],
				};
			});
			adapter.writeLog(`[ CreateLightGroupsObject ] LightGroups: ${JSON.stringify(adapter.LightGroups)}`);
		} else {
			adapter.writeLog(`[ CreateLightGroupsObject ] No LightGroups defined in instance settings!`, "warn");
		}
	} catch (error) {
		adapter.errorHandling(error, "CreateLightGroupsObject");
	}
}

/**
 * GlobalLuxHandling
 * @description If a global lux sensor has been defined, its value is written to the global variable and the state is subscribed.
 * @param adapter Adapter-Class
 */
async function GlobalLuxHandling(adapter) {
	try {
		const { Settings } = adapter;
		const { GlobalLuxSensor } = Settings;

		if (!GlobalLuxSensor) return;

		const actualGenericLux = await adapter.getForeignStateAsync(GlobalLuxSensor);

		if (!actualGenericLux || actualGenericLux.val === "") return;

		adapter.ActualGenericLux = actualGenericLux.val;

		if (typeof adapter.ActualGenericLux !== "number") {
			adapter.log.warn(
				`[ GlobalLuxHandling ] ActualGenericLux ObjectID "${GlobalLuxSensor}" is not a number: ${adapter.ActualGenericLux}`,
			);
			return;
		}

		await adapter.subscribeForeignStatesAsync(GlobalLuxSensor);
		adapter.LuxSensors.push(GlobalLuxSensor);
	} catch (error) {
		adapter.errorHandling(error, "GlobalLuxHandling");
	}
}

/**
 * DoAllTheSensorThings
 * @param adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function DoAllTheMotionSensorThings(adapter, Group) {
	try {
		const LightGroups = adapter.LightGroups;

		adapter.writeLog(`[ DoAllTheMotionSensorThings ] Reaching, Group = "${Group}`);

		for (const sensor of LightGroups[Group].sensors) {
			const _motionState = await adapter.getForeignStateAsync(sensor.oid);
			if (_motionState) {
				sensor.isMotion = _motionState.val == sensor.motionVal;
				adapter.log.debug(
					`[ DoAllTheMotionSensorThings ] Group="${Group}" SensorID="${sensor.oid}" MotionVal="${sensor.isMotion}"`,
				);
				await adapter.subscribeForeignStatesAsync(sensor.oid);
				adapter.MotionSensors.push(sensor.oid);
			} else {
				adapter.log.debug(
					`[ DoAllTheMotionSensorThings ] Group="${Group}" ${sensor.oid} has no data, skipping subscribe`,
				);
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "DoAllTheMotionSensorThings");
	}
}

/**
 * DoAllTheLuxSensorThings
 * @description Read the current lux value per group. However, if no individual lux sensor has been defined, a global lux sensor is assigned to the group.
 * @param adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function DoAllTheLuxSensorThings(adapter, Group) {
	const LightGroups = adapter.LightGroups;
	try {
		const luxSensor = LightGroups[Group].LuxSensor || adapter.Settings.GlobalLuxSensor;

		if (luxSensor) {
			if (luxSensor === adapter.Settings.GlobalLuxSensor) {
				LightGroups[Group].actualLux = adapter.ActualGenericLux ?? null;
				adapter.writeLog(`[ DoAllTheLuxSensorThings ] Group "${Group}" using generic luxsensor.`);
			} else {
				const individualLux = await adapter.getForeignStateAsync(luxSensor);

				if (individualLux !== null) {
					LightGroups[Group].actualLux = individualLux.val;

					if (
						typeof LightGroups[Group].actualLux === "number" &&
						LightGroups[Group].actualLux.toString().length !== 0
					) {
						await adapter.subscribeForeignStatesAsync(luxSensor);
						adapter.LuxSensors.push(luxSensor);
						adapter.writeLog(
							`[ DoAllTheLuxSensorThings ] Group="${Group}" using individual luxsensor "${luxSensor}", value is: ${LightGroups[Group].actualLux}`,
						);
					} else {
						adapter.writeLog(
							`[ DoAllTheLuxSensorThings ] Group="${Group}" using individual luxsensor "${luxSensor}" which is not a number or it is empty!!!`,
							"warn",
						);
					}
				}
			}
		} else {
			await helper.SetValueToObject(LightGroups[Group], ".actualLux", 0);
			adapter.writeLog(
				`[ DoAllTheLuxSensorThings ] No Luxsensor for Group="${Group}" defined, set actualLux = 0, skip handling`,
			);
		}
		await helper.SetValueToObject(LightGroups[Group], ".actualLux", luxSensor ? LightGroups[Group].actualLux : 0);
	} catch (error) {
		adapter.errorHandling(error, "DoAllTheLuxSensorThings");
	}
}

/**
 * GlobalPresenceHandling
 * @param adapter
 */
async function GlobalPresenceHandling(adapter) {
	try {
		if (adapter.Settings.PresenceCountDp) {
			adapter.writeLog(`[ GlobalPresenceHandling ] PresenceCounteDp=${adapter.Settings.PresenceCountDp}`);
			adapter.ActualPresenceCount.newVal = (
				await adapter.getForeignStateAsync(adapter.Settings.PresenceCountDp)
			).val;

			if (typeof adapter.ActualPresenceCount.newVal === "number") {
				//Subscribe PresenceCountDp
				await adapter.subscribeForeignStatesAsync(adapter.Settings.PresenceCountDp);
			} else {
				adapter.writeLog(
					`[ GlobalPresenceHandling ] PresenceCounterDp=${adapter.Settings.PresenceCountDp} is not type="number"!`,
					"warn",
				);
			}
		}

		if (adapter.Settings.IsPresenceDp) {
			adapter.writeLog(`[ GlobalPresenceHandling ] IsPresenceDp=${adapter.Settings.IsPresenceDp}`);
			adapter.ActualPresence = (await adapter.getForeignStateAsync(adapter.Settings.IsPresenceDp)).val;

			if (typeof adapter.ActualPresence === "boolean") {
				//Subscribe IsPresenceDp
				await adapter.subscribeForeignStatesAsync(adapter.Settings.IsPresenceDp);
			} else {
				adapter.writeLog(
					`[ GlobalPresenceHandling ] isPresenceDp=${adapter.Settings.IsPresenceDp} is not type="boolean"!`,
					"warn",
				);
			}
		}

		adapter.ActualPresence = adapter.ActualPresenceCount.newVal == 0 ? false : true;
	} catch (error) {
		adapter.errorHandling(error, "GlobalPresenceHandling");
	}
}

/**
 * State create, extend objects and subscribe states
 * @param adapter
 */
async function StatesCreate(adapter) {
	adapter.log.debug("[ StatesCreate ] Start Creating devices...");

	const LightGroups = adapter.LightGroups;

	const keepStates = [];
	const keepChannels = [];
	const keepDevices = [];

	keepStates.push("info.connection");
	keepChannels.push("info");

	/** @type {ioBroker.State} */
	let state;

	//Loop LightGroups and create devices
	for (const Group in LightGroups) {
		if (Group === "All") continue;
		//Create device if not exist
		await CreateDevice(adapter, Group, Group);
		keepDevices.push(Group);

		await DoAllTheMotionSensorThings(adapter, Group);
		await DoAllTheLuxSensorThings(adapter, Group);

		try {
			for (const prop1 in DeviceTemplate) {
				const dp = Group + "." + prop1;
				// Check for second layer
				if (typeof DeviceTemplate[prop1].name == "undefined") {
					//Create channel if not exist
					await CreateChannel(adapter, dp, Group + " " + prop1);
					keepChannels.push(dp);

					for (const key in DeviceTemplate[prop1]) {
						const dp = Group + "." + prop1 + "." + key;
						const common = DeviceTemplate[prop1][key];

						//create datapoint
						await CreateStates(adapter, dp, common);
						keepStates.push(dp);

						//Get value of state and set value to LightGroup
						state = await adapter.getStateAsync(dp);

						if (state != null) {
							await helper.SetValueToObject(LightGroups, dp, state.val);
						} else {
							adapter.writeLog(`[ StatesCreate ] State: "${dp}" is NULL or undefined!`, "warn");
						}

						// Subscribe on state changes if writable
						common.write && (await adapter.subscribeStatesAsync(dp));
					}
				} else {
					const common = DeviceTemplate[prop1];
					//create datapoint
					await CreateStates(adapter, dp, common);
					keepStates.push(dp);

					//Get value of state and set value to LightGroup
					state = await adapter.getStateAsync(dp);

					if (prop1 === "power") {
						adapter.writeLog(
							`[ StatesCreate ] Group="${Group}", Prop1="${prop1}", powerNewVal="${state.val}"`,
						);
						await helper.SetValueToObject(LightGroups[Group], ".powerNewVal", state.val);
					}

					if (state !== null) {
						await helper.SetValueToObject(LightGroups, dp, state.val);
					} else {
						adapter.writeLog(`[ StatesCreate ] State: "${dp}" is NULL or undefined!`, "warn");
					}

					// Subscribe on state changes if writable
					common.write && (await adapter.subscribeStatesAsync(dp));
				}
			}
			await helper.SetValueToObject(
				LightGroups[Group],
				[".autoOnLux.dailyLockCounter", ".autoOffLux.dailyLockCounter"],
				0,
			);
		} catch (error) {
			adapter.errorHandling(error, "StateCreate");
		}
	}

	//Create All-Channel if not exists
	await CreateDevice(adapter, "All", "Controll all groups together");
	keepDevices.push("All");

	for (const prop1 in DeviceAllTemplate) {
		try {
			const dp = "All." + prop1;
			const common = DeviceAllTemplate[prop1];

			await CreateStates(adapter, dp, common);
			keepStates.push(dp);

			//Get value of state and set value to LightGroup
			const state = await adapter.getStateAsync(dp);

			if (prop1 === "power") {
				adapter.writeLog(`[ StateCreate ] Group="All", Prop1="${prop1}", powerNewVal="${state.val}"`);
				await helper.SetValueToObject(LightGroups, "All.powerNewVal", state.val);
			}

			if (state != null) {
				await helper.SetValueToObject(LightGroups, dp, state.val);
			} else {
				adapter.writeLog(`[ StateCreate ] State: "${dp}" is NULL or undefined!`, "warn");
			}

			// Subscribe on state changes if writable
			common.write && (await adapter.subscribeStatesAsync(dp));
		} catch (error) {
			adapter.errorHandling(error, "StateCreate");
		}
	}

	// Delete non existent states, channels and devices
	const allStates = [];
	const allChannels = [];
	const allDevices = [];

	const objects = await adapter.getAdapterObjectsAsync();

	for (const o in objects) {
		const parts = o.split(".");
		if (parts[2] != "info") {
			const id = await helper.removeNamespace(adapter, objects[o]._id);

			if (objects[o].type == "state") {
				allStates.push(id);
			} else if (objects[o].type == "channel") {
				allChannels.push(id);
			} else if (objects[o].type == "device") {
				allDevices.push(id);
			}
		}
	}

	try {
		for (let i = 0; i < allStates.length; i++) {
			const id = allStates[i];
			if (keepStates.indexOf(id) === -1) {
				adapter.delObject(id, { recursive: true }, () => {
					adapter.writeLog("[ StateCreate ] State deleted " + id);
				});
			}
		}
		for (let i = 0; i < allChannels.length; i++) {
			const id = allChannels[i];
			if (keepChannels.indexOf(id) === -1) {
				adapter.delObject(id, { recursive: true }, () => {
					adapter.writeLog("[ StateCreate ] Channel deleted" + id);
				});
			}
		}
		for (let i = 0; i < allDevices.length; i++) {
			const id = allDevices[i];
			if (keepDevices.indexOf(id) === -1) {
				adapter.delObject(id, { recursive: true }, () => {
					adapter.writeLog("[ StateCreate ] Devices deleted" + id);
				});
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "StateCreate / Delete");
	}

	return LightGroups;
}

/**
 * clean Dev_Mode userdata
 */
async function CleanUserData(adapter) {
	const userdata = "0_userdata.0.lightcontrol_DEV.";
	try {
		adapter.delObject(userdata, { recursive: true }, () => {
			adapter.writeLog("Test objects deleted" + userdata);
		});
	} catch (error) {
		adapter.errorHandling(error, "CleanUserData");
	}
}

/**
 * State create, extend objects and subscribe states
 */
async function TestStatesCreate(adapter) {
	adapter.log.debug("Creating Test devices...");

	const userdata = "0_userdata.0.lightcontrol_DEV.";

	try {
		//Loop TestLamps and create datapoints to 0_userdata.0
		for (const Lamp in TestTemplateLamps) {
			//Create Lamp if not exist
			await adapter.setForeignObjectNotExistsAsync(userdata + "Lamps." + Lamp, {
				type: "channel",
				common: { name: Lamp },
				native: {},
			});

			for (const prop1 in TestTemplateLamps[Lamp]) {
				const common = TestTemplateLamps[Lamp][prop1];
				const dp = userdata + "Lamps." + Lamp + "." + prop1;
				await CreateStates(adapter, dp, common, true);
			}
		}

		//Loop Test Motion Sensors and create datapoints to 0_userdata.0
		for (const MotionSensor in TestTemplateMotionSensors) {
			const common = TestTemplateMotionSensors[MotionSensor];
			const dp = userdata + "MotionSensors." + MotionSensor;
			await CreateStates(adapter, dp, common, true);
		}

		//Loop Test Lux Sensors and create datapoints to 0_userdata.0
		for (const LuxSensor in TestTemplateLuxSensors) {
			const common = TestTemplateLuxSensors[LuxSensor];
			const dp = userdata + "LuxSensors." + LuxSensor;
			await CreateStates(adapter, dp, common, true);
		}

		//Loop Test Presence and create datapoints to 0_userdata.0
		for (const Presence in TestTemplatePresence) {
			const common = TestTemplatePresence[Presence];
			const dp = userdata + "Presence." + Presence;
			await CreateStates(adapter, dp, common, true);
		}
	} catch (error) {
		adapter.errorHandling(error, "TestStatesCreate");
	}
}

/**
 * Create datapoint and extend datapoints
 * @author Schmakus
 * @async
 * @param {Object} adapter
 * @param {string} dp path to datapoint
 * @param {ioBroker.StateCommon} common type of datapoint, e.g. string, number, boolean, ...
 * @param {boolean} [foreign = false] set adapter states = false; set foreign states = true
 */
async function CreateStates(adapter, dp, common, foreign) {
	try {
		const obj = !foreign ? await adapter.getObjectAsync(dp) : await adapter.getForeignObjectAsync(dp);

		if (!obj) {
			if (!foreign) {
				await adapter.setObjectNotExistsAsync(dp, {
					type: "state",
					common: common,
					native: {},
				});
			} else {
				await adapter.setForeignObjectNotExistsAsync(dp, {
					type: "state",
					common: common,
					native: {},
				});
			}

			adapter.writeLog(`[ CreateStates ] State: ${dp} created.`);
		} else {
			if (JSON.stringify(obj.common) !== JSON.stringify(common)) {
				if (!foreign) {
					await adapter.setObjectAsync(dp, {
						type: "state",
						common: common,
					});
				} else {
					await adapter.setForeignObjectAsync(dp, {
						type: "state",
						common: common,
					});
				}
				adapter.writeLog(`[ CreateStates ] State: "${dp}" extended`);
			}
		}
	} catch (error) {
		adapter.errorHandling(error, "CreateStates");
	}
}
/**
 * Create channel and extend
 * @author Schmakus
 * @async
 * @param {Object} adapter
 * @param {string} dp path to datapoint
 * @param {string} name name of the channel
 */
async function CreateChannel(adapter, dp, name) {
	try {
		await adapter.extendObjectAsync(dp, {
			type: "channel",
			common: {
				name: name,
			},
			native: {},
		});
	} catch (error) {
		adapter.errorHandling(error, "CreateChannel");
	}
}
/**
 * Create device and extend
 * @author Schmakus
 * @async
 * @param adapter
 * @param {string} dp path to datapoint
 * @param {string} name name of the channel
 */
async function CreateDevice(adapter, dp, name) {
	try {
		await adapter.extendObjectAsync(dp, {
			type: "device",
			common: {
				name: name,
			},
			native: {},
		});
	} catch (error) {
		adapter.errorHandling(error, "CreateDevice");
	}
}

module.exports = {
	Init,
	CleanUserData,
	DoAllTheMotionSensorThings,
	CreateLightGroupsObject,
};
