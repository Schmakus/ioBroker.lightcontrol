"use strict";

const helper = require("./helper");
const { DeviceTemplate, DeviceAllTemplate } = require(`./groupTemplates`);
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
	adapter.log.debug(`Init is starting...`);
	if (adapter.DevMode) await TestStatesCreate(adapter);
	await CreateLightGroupsObject(adapter);
	await GlobalLuxHandling(adapter);
	await GlobalPresenceHandling(adapter);
	await StatesCreate(adapter);
	adapter.log.debug("Init finished");
}

/**
 * Create LightGroups Object
 * @description Creates Object LightGroups from system.config array
 * @param adapter Adapter-Class
 */
async function CreateLightGroupsObject(adapter) {
	for (const Groups of adapter._LightGroups) {
		let _temp;
		for (const [key, value] of Object.entries(Groups)) {
			if (key === "Group") {
				adapter.LightGroups[value] = {};
				adapter.LightGroups[value].description = value;
				_temp = value;
			} else {
				adapter.LightGroups[_temp].LuxSensor = value;
				adapter.LightGroups[_temp].lights = {};
				adapter.LightGroups[_temp].sensors = {};
			}
		}
	}
}

/**
 * GlobalLuxHandling
 * @description If a global lux sensor has been defined, its value is written to the global variable and the state is subscribed.
 * @param adapter Adapter-Class
 */
async function GlobalLuxHandling(adapter) {
	if (adapter.GlobalSettings.GlobalLuxSensor !== "") {
		const _actualGenericLux = await adapter
			.getForeignStateAsync(adapter.GlobalSettings.GlobalLuxSensor)
			.catch((e) => adapter.log.error("GlobalLuxHandling Get State Value => " + e));

		if (_actualGenericLux) {
			adapter.ActualGenericLux = _actualGenericLux.val;

			if (typeof adapter.ActualGenericLux === "number" && adapter.ActualGenericLux !== "") {
				await adapter.subscribeForeignStatesAsync(adapter.GlobalSettings.GlobalLuxSensor);
				adapter.LuxSensors.push(adapter.GlobalSettings.GlobalLuxSensor);
			} else {
				adapter.log.warn(
					`GlobalLuxHandling => ActualGenericLux ObjectID "${adapter.GlobalSettings.GlobalLuxSensor}" is not a number or it is empty: ${adapter.ActualGenericLux}`,
				);
			}
		} else {
			adapter.log.warn(
				`GlobalLuxHandling => ObjectID "${adapter.GlobalSettings.GlobalLuxSensor}" liefert NULL, undefined!!`,
			);
		}
	}
}

/**
 * DoAllTheSensorThings
 * @param adapter Adapter-Class
 * @param {string} Group Group of Lightgroups eg. LivingRoom, Children1,...
 */
async function DoAllTheMotionSensorThings(adapter, Group) {
	const LightGroups = adapter.LightGroups;

	adapter.log.debug(`Reaching DoAllTheMotionSensorThings`);

	for (const sensorCount in adapter.LightGroups[Group].sensors) {
		//Read sensor value and put them to LightGroups
		const _motionState = await adapter
			.getForeignStateAsync(LightGroups[Group].sensors[sensorCount].oid)
			.catch((e) => adapter.log.error(e));
		if (_motionState) {
			LightGroups[Group].sensors[sensorCount].isMotion =
				_motionState.val == LightGroups[Group].sensors[sensorCount].motionVal ? true : false;
			adapter.log.debug(
				`DoAllTheMotionSensorThings => Group="${Group}" SensorID="${LightGroups[Group].sensors[sensorCount].oid}" MotionVal="${LightGroups[Group].sensors[sensorCount].isMotion}"`,
			);
			adapter.subscribeForeignStatesAsync(LightGroups[Group].sensors[sensorCount].oid);
			adapter.MotionSensors.push(LightGroups[Group].sensors[sensorCount].oid);
		} else {
			adapter.log.debug(
				`DoAllTheMotionSensorThings => Group="${Group}" ${LightGroups[Group].sensors[sensorCount].oid} has no data, skipping subscribe`,
			);
		}
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
	adapter.log.debug(`Reaching DoAllTheLuxSensorThings for Group="${Group}"`);

	//Add GlobalLuxSensor to Group if it has no own Sensor
	if (
		(LightGroups[Group].LuxSensor === "" || LightGroups[Group].LuxSensor === undefined) &&
		adapter.GlobalSettings.GlobalLuxSensor !== ""
	) {
		adapter.log.debug(`DoAllTheLuxSensorThings => Add Global Lux Sensor to Group="${Group}"`);
		LightGroups[Group].LuxSensor = adapter.GlobalSettings.GlobalLuxSensor;
	}

	if (LightGroups[Group].LuxSensor !== "" || LightGroups[Group].LuxSensor !== undefined) {
		adapter.log.debug(
			`DoAllTheLuxSensorThings => LightGroups["${Group}"].LuxSensor="${LightGroups[Group].LuxSensor}"`,
		);

		//If GlobalLuxSensor used for Group, don't read it again and use global lux value
		if (LightGroups[Group].LuxSensor === adapter.GlobalSettings.GlobalLuxSensor) {
			LightGroups[Group].actualLux = adapter.ActualGenericLux;
			if (LightGroups[Group].actualLux) {
				adapter.writeLog(`DoAllTheLuxSensorThings => Group "${Group}" using generic luxsensor.}`);
			} else {
				adapter.writeLog(
					`DoAllTheLuxSensorThings => Group "${Group}" using generic luxsensor, but the value is NULL or empty!}`,
					"warn",
				);
			}
		} else {
			// Read individual lux value for group
			const _actualLux = await adapter
				.getForeignStateAsync(LightGroups[Group].LuxSensor)
				.catch((e) => adapter.log.error("DoAllTheLuxSensorThings => " + e));
			if (_actualLux) {
				LightGroups[Group].actualLux = _actualLux.val;

				if (typeof LightGroups[Group].actualLux === "number" && LightGroups[Group].actualLux.length !== 0) {
					await adapter.subscribeForeignStatesAsync(LightGroups[Group].LuxSensor);
					adapter.LuxSensors.push(LightGroups[Group].LuxSensor);
					adapter.log.debug(
						`DoAllTheLuxSensorThings => Group="${Group}" using individual luxsensor "${LightGroups[Group].LuxSensor}", value is: ${LightGroups[Group].actualLux}`,
					);
				} else {
					adapter.log.warn(
						`DoAllTheLuxSensorThings => Group="${Group}" using individual luxsensor "${LightGroups[Group].LuxSensor}" which is not a number or it is empty!!!`,
					);
				}
			} else {
				adapter.log.debug(
					`DoAllTheLuxSensorThings => No Luxsensor for Group="${Group}" defined, skip handling`,
				);
			}
		}
	}
}

/**
 * GlobalPresenceHandling
 * @param adapter
 */
async function GlobalPresenceHandling(adapter) {
	try {
		if (adapter.GlobalSettings.PresenceCountDp !== "") {
			adapter.log.debug(`GlobalPresenceHandling: PresenceCounteDp=${adapter.GlobalSettings.PresenceCountDp}`);
			adapter.ActualPresenceCount.newVal = (
				await adapter.getForeignStateAsync(adapter.GlobalSettings.PresenceCountDp)
			).val;

			if (typeof adapter.ActualPresenceCount.newVal === "number") {
				//Subscribe PresenceCountDp
				await adapter.subscribeForeignStatesAsync(adapter.GlobalSettings.PresenceCountDp);
			} else {
				adapter.log.warn(
					`GlobalPresenceHandling: PresenceCounterDp=${adapter.GlobalSettings.PresenceCountDp} is not type="number"!`,
				);
			}
		}
	} catch (e) {
		adapter.log.error(
			`GlobalPresenceHandling: Object-ID "adapter.GlobalSettings.PresenceCounterDp" not exits. Please check your config! (${e})`,
		);
	}

	try {
		if (adapter.GlobalSettings.IsPresenceDp !== "") {
			adapter.log.debug(`GlobalPresenceHandling: IsPresenceDp=${adapter.GlobalSettings.IsPresenceDp}`);
			adapter.ActualPresence = (await adapter.getForeignStateAsync(adapter.GlobalSettings.IsPresenceDp)).val;

			/*
			if (typeof adapter.ActualPresence === "boolean") {
				//Subscribe IsPresenceDp
				await adapter.subscribeForeignStatesAsync(adapter.GlobalSettings.IsPresenceDp);

			} else {
				adapter.log.warn(`GlobalPresenceHandling: isPresenceDp=${adapter.GlobalSettings.IsPresenceDp} is not type="boolean"!`);
			}
			*/
		}
	} catch (e) {
		adapter.log.error(
			`GlobalPresenceHandling: Object-ID "adapter.GlobalSettings.IsPresenceDp" not exits. Please check your config! (${e})`,
		);
	}

	adapter.ActualPresence = adapter.ActualPresenceCount.newVal == 0 ? false : true;
}

/**
 * State create, extend objects and subscribe states
 * @param adapter
 */
async function StatesCreate(adapter) {
	adapter.log.debug("Start: Creating devices...");

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
							adapter.log.warn("State: " + dp + " is NULL or undefined!");
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
						adapter.log.debug(
							`CreateStates => Group="${Group}", Prop1="${prop1}", powerNewVal="${state.val}"`,
						);
						await helper.SetValueToObject(LightGroups, Group + ".powerNewVal", state.val);
					}

					if (state != null) {
						await helper.SetValueToObject(LightGroups, dp, state.val);
					} else {
						adapter.log.warn("State: " + dp + " is NULL or undefined!");
					}

					// Subscribe on state changes if writable
					common.write && (await adapter.subscribeStatesAsync(dp));
				}
			}

			LightGroups[Group].autoOnLux.dailyLockCounter = 0;
			LightGroups[Group].autoOffLux.dailyLockCounter = 0;
		} catch (e) {
			adapter.log.warn("CreateStates: " + e);
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
				adapter.log.debug(`CreateStates => Group="All", Prop1="${prop1}", powerNewVal="${state.val}"`);
				await helper.SetValueToObject(LightGroups, "All.powerNewVal", state.val);
			}

			if (state != null) {
				await helper.SetValueToObject(LightGroups, dp, state.val);
			} else {
				adapter.log.warn("State: " + dp + " is NULL or undefined!");
			}

			// Subscribe on state changes if writable
			common.write && (await adapter.subscribeStatesAsync(dp));
		} catch (e) {
			adapter.log.warn("Error by crating All channel: " + prop1 + " Error: " + e);
			await adapter.setStateAsync("info.connection", false, true);
		}
	}

	// Delete non existent states, channels and devices
	const allStates = [];
	const allChannels = [];
	const allDevices = [];

	const objects = await adapter.getAdapterObjectsAsync();

	//adapter.log.debug("allStates: " + JSON.stringify(objects));
	//adapter.log.debug("keepStates: " + keepStates);

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
					adapter.log.debug("State deleted " + id);
				});
			}
		}
		for (let i = 0; i < allChannels.length; i++) {
			const id = allChannels[i];
			if (keepChannels.indexOf(id) === -1) {
				adapter.delObject(id, { recursive: true }, () => {
					adapter.log.debug("Channel deleted" + id);
				});
			}
		}
		for (let i = 0; i < allDevices.length; i++) {
			const id = allDevices[i];
			if (keepDevices.indexOf(id) === -1) {
				adapter.delObject(id, { recursive: true }, () => {
					adapter.log.debug("Devices deleted" + id);
				});
			}
		}
	} catch (e) {
		adapter.log.error("Error by deleting states. Error: " + e);
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
			adapter.log.debug("Test objects deleted" + userdata);
		});
	} catch (e) {
		adapter.log.error("Error by CleanUserData: " + e);
	}
}

/**
 * State create, extend objects and subscribe states
 */
async function TestStatesCreate(adapter) {
	adapter.log.debug("Creating Test devices...");

	const userdata = "0_userdata.0.lightcontrol_DEV.";

	//Loop TestLamps and create datapoints to 0_userdata.0
	try {
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
				//create datapoint
				await adapter.setForeignObjectNotExistsAsync(dp, {
					type: "state",
					common: common,
					native: {},
				});
			}
		}
	} catch (e) {
		adapter.log.error("Error by crating test lamps: " + e);
	}
	//Loop Test Motion Sensors and create datapoints to 0_userdata.0
	try {
		for (const MotionSensor in TestTemplateMotionSensors) {
			const common = TestTemplateMotionSensors[MotionSensor];
			const dp = userdata + "MotionSensors." + MotionSensor;
			//create datapoint
			await adapter.setForeignObjectNotExistsAsync(dp, {
				type: "state",
				common: common,
				native: {},
			});
		}
	} catch (e) {
		adapter.log.error("Error by creating test motion sensors: " + e);
	}
	//Loop Test Lux Sensors and create datapoints to 0_userdata.0
	try {
		for (const LuxSensor in TestTemplateLuxSensors) {
			const common = TestTemplateLuxSensors[LuxSensor];
			const dp = userdata + "LuxSensors." + LuxSensor;
			//create datapoint
			await adapter.setForeignObjectNotExistsAsync(dp, {
				type: "state",
				common: common,
				native: {},
			});
		}
	} catch (e) {
		adapter.log.error("Error by creating test lux sensors: " + e);
	}
	//Loop Test Presence and create datapoints to 0_userdata.0
	try {
		for (const Presence in TestTemplatePresence) {
			const common = TestTemplatePresence[Presence];
			const dp = userdata + "Presence." + Presence;
			//create datapoint
			await adapter.setForeignObjectNotExistsAsync(dp, {
				type: "state",
				common: common,
				native: {},
			});
		}
	} catch (e) {
		adapter.log.error(`Error by creating test presence dp: ${e}`);
	}
}

/**
 * Create datapoint and extend datapoints
 * @author Schmakus
 * @async
 * @param adapter
 * @param {string} dp path to datapoint
 * @param {ioBroker.StateCommon} common type of datapoint, e.g. string, number, boolean, ...
 */
async function CreateStates(adapter, dp, common) {
	try {
		await adapter.setObjectNotExistsAsync(dp, {
			type: "state",
			common: common,
			native: {},
		});

		if (adapter.config.debug) adapter.log.debug("State: " + dp + " was created if did not exist");

		const obj = await adapter.getObjectAsync(dp);

		if (obj != null) {
			if (
				obj.common.role != common.role ||
				obj.common.type != common.type ||
				obj.common.unit != common.unit ||
				obj.common.read != common.read ||
				obj.common.write != common.write ||
				obj.common.name != common.name ||
				obj.common.def != common.def
			) {
				await adapter.extendObjectAsync(dp, {
					common: common,
				});
				adapter.log.debug("State :" + dp + " was extended");
			}
		}
	} catch (e) {
		adapter.log.error("Error by crating state: " + e);
	}
}
/**
 * Create channel and extend
 * @author Schmakus
 * @async
 * @param adapter
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
		if (adapter.config.debug) adapter.log.debug("Channel: " + dp + " was created if did not exist");
	} catch (e) {
		adapter.log.error("Error by crating channel: " + e);
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
		if (adapter.config.debug) adapter.log.debug("Device: " + dp + " was created if did not exist");
	} catch (e) {
		adapter.log.error("Error by crating device: " + e);
	}
}

module.exports = {
	Init,
	CleanUserData,
};
