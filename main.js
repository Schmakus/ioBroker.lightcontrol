"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.1
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require("@iobroker/adapter-core");
// eslint-disable-next-line no-unused-vars
const helper =require("./lib/helper");
const init =require("./lib/init");
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
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
		this.GlobalSettings = {};
		this.LightGroups = {};
		this.LuxSensors = [];
		this.MotionSensors = [];

		this.ActualGenericLux = 0;
		this.ActualPresence = true;
		this.ActualPresenceCount = { newVal: 1, oldVal: 1};

		this.RampOnIntervalObject = {};
		this.RampOffIntervalObject = {};
		this.AutoOffTimeoutObject = {};
		this.AutoOffNoticeTimeoutObject = {};

		this.TickerIntervall = null;
		this.BlinkIntervalObj = {};

		this.lat = "";
		this.lng = "";

		this.DevMode = false;

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
		this.GlobalSettings = this.config.GlobalSettings;
		//this.log.debug("GlobalSettings: " + JSON.stringify(this.GlobalSettings));
		this.LightGroups = this.config.LightGroups;
		//this.log.debug("LightGroups: " + JSON.stringify(this.LightGroups));

		//Create all States, Devices and Channels
		await init.Init(this).catch((e) => this.log.error(`onRready // Init => ${e}`));
		if (this.config.debug) this.log.debug(JSON.stringify(this.LightGroups));

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

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

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
						this.log.debug(`onStateChange => CheckInputGeneral for ${id} with state: ${NewVal} is: ${_state}`);

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
						if(this.LuxSensors.includes(id)) {

							for (const Group in this.LightGroups) {

								if(this.LightGroups[Group].LuxSensor === id) {

									if (state.val !== this.LightGroups[Group].actualLux) {

										this.log.debug(`onStateChange => It's a LuxSensor in following Group: ${Group}`);
										this.LightGroups[Group].actualLux = state.val;
										await this.Controller(Group, "actualLux", state.val, this.LightGroups[Group].actualLux, "");
									}

								}
							}

						//Check if it's a MotionSensor
						} else if (this.MotionSensors.includes(id)){

							for (const Group in this.LightGroups) {

								if (Group === "All") continue;

								for (const Sensor in this.LightGroups[Group].sensors) {
									if(this.LightGroups[Group].sensors[Sensor].oid === id) {

										this.log.debug(`onStateChange => It's a MotionSensor in following Group: ${Group}`);

										if (state.val === this.LightGroups[Group].sensors[Sensor].motionVal) { //Inhalt lesen und neues Property anlegen und füllen
											this.LightGroups[Group].sensors[Sensor].isMotion = true;
											this.log.debug(`onStateChange => Sensor="${Sensor}" in Group="${Group}". This isMotion="true"`);
										} else {
											this.LightGroups[Group].sensors[Sensor].isMotion = false;
											this.log.debug(`onStateChange => Sensor="${Sensor}" in Group="${Group}". This isMotion="false"`);
										}

										await this.SummarizeSensors(Group).catch((e) => this.log.error(e));

									}
								}
							}

						//Check if it's Presence
						} else if (this.GlobalSettings.IsPresenceDp === id) {
							this.log.debug(`onStateChange => It's IsPresenceDp: ${id}`);

							this.ActualPresence = (typeof state.val === "boolean") ? state.val : false;
							await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));

						//Check if it's Presence Counter
						} else if (this.GlobalSettings.PresenceCountDp === id) {
							this.log.debug(`onStateChange => It's PresenceCountDp: ${id}`);

							this.ActualPresenceCount.oldVal = this.ActualPresenceCount.newVal;
							this.ActualPresenceCount.newVal = (typeof state.val === "number") ? state.val : 0;

							if(this.ActualPresenceCount.newVal > this.ActualPresenceCount.oldVal) {
								this.log.debug(`onStateChange => PresenceCountDp value is greater than old value: ${state.val}`);
								await switchingOnOff.AutoOnPresenceIncrease(this).catch((e) => this.log.error(e));
							}

						}
					}
				}

			} else {
				// The state was deleted
				this.log.debug(`onStateChange => state ${id} deleted`);
			}
		} catch(e) {
			this.log.error(`onStateChange => ${e}`);
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
	async Controller(Group, prop1, NewVal, OldVal, id="") { //Used by all
		try {
			const LightGroups = this.LightGroups;
			let handeled = false;

			this.log.info(`Reaching Controller, Group="${Group}" Property="${prop1}" NewVal="${NewVal}", OldVal="${(OldVal === undefined) ? "" : OldVal}"`);

			await helper.SetValueToObject(LightGroups[Group], prop1, NewVal);

			switch (prop1) {
				case "actualLux":
					if (!LightGroups[Group].powerCleaningLight) { //Autofunktionen nur wenn Putzlicht nicht aktiv
						await switchingOnOff.AutoOnLux(this, Group);
						await switchingOnOff.AutoOffLux(this, Group);
						if (this.LightGroups[Group].adaptiveBri) await lightHandling.SetBrightness(this, Group, await lightHandling.AdaptiveBri(this, Group));
						await switchingOnOff.AutoOnMotion(this, Group);
					}
					handeled = true;
					break;
				case "isMotion":
					if (!this.LightGroups[Group].powerCleaningLight) {

						if (LightGroups[Group].isMotion && LightGroups[Group].power) { //AutoOff Timer wird nach jeder Bewegung neugestartet
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
						if (LightGroups[Group].color == "#FFFFFF") await lightHandling.SetWhiteSubstituteColor(this, Group);
						await lightHandling.SetColorMode(this, Group);
					}
					handeled = true;
					break;
				case "power":
					if (NewVal !== OldVal) {

						await switchingOnOff.GroupPowerOnOff(this, Group, NewVal); //Alles schalten
						await lightHandling.PowerOnAftercare(this, Group);
						if (!NewVal && LightGroups[Group].autoOffTimed.enabled) { //Wenn ausschalten und autoOffTimed ist aktiv, dieses löschen, da sonst erneute ausschaltung nach Ablauf der Zeit. Ist zusätzlich rampon aktiv, führt dieses zu einem einschalten mit sofort folgenden ausschalten
							await timers.clearAutoOffTimeouts(this, Group);
							//if (typeof this.AutoOffTimeoutObject[Group] == "object") clearTimeout(this.AutoOffTimeoutObject[Group]);
						}
						if (!NewVal && LightGroups[Group].powerCleaningLight) { //Wenn via Cleaninglight angeschaltet wurde, jetzt aber normal ausgeschaltet, powerCleaningLight synchen um Blockade der Autofunktionen zu vermeiden
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
					await this.setStateAsync(Group + "." + "bri", (Math.min(Math.max(LightGroups[Group].bri + LightGroups[Group].dimmAmount, 10), 100)), false);
					handeled = true;
					break;
				case "dimmDown":
					await this.setStateAsync(Group + "." + "bri", (Math.min(Math.max(LightGroups[Group].bri - LightGroups[Group].dimmAmount, 2), 100)), false);
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
					await switchingOnOff.blink(this, Group);
					handeled = true;
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
		} catch(e) {
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
					this.log.debug(`SummarizeSensors => Group="${Group}" Sensor="${Sensor}" with target ${this.LightGroups[Group].sensors[Sensor].oid} has value ${this.LightGroups[Group].sensors[Sensor].isMotion}`);
					Motionstate = true;
				}
			}

			if (this.LightGroups[Group].isMotion !== Motionstate) {
				this.log.debug(`SummarizeSensors => Summarized IsMotion for Group="${Group}" = ${Motionstate}, go to Controller...`);
				this.LightGroups[Group].isMotion = Motionstate;
				await this.setStateAsync(Group + ".isMotion", Motionstate, true);
				await this.Controller(Group, "isMotion", this.LightGroups[Group].isMotion, Motionstate);

			} else {
				this.log.debug(`SummarizeSensors => No Motionstate="${Group}" = ${Motionstate}, nothing changed -> nothin to do`);
			}


		} catch(e) {
			this.log.error(`SummarizeSensors => ${e}`);
		}
	}

	/**
	 * Get System Longitude and Latitute
	 */
	async GetSystemData() {
		//if (typeof adapter.config.longitude == undefined || adapter.config.longitude == null || adapter.config.longitude.length == 0 || isNaN(adapter.config.longitude)
		//	|| typeof adapter.config.latitude == undefined || adapter.config.latitude == null || adapter.config.latitude.length == 0 || isNaN(adapter.config.latitude)) {
		try {
			const obj = await this.getForeignObjectAsync("system.config", "state");

			if (obj && obj.common && obj.common.longitude && obj.common.latitude) {
				this.lng = obj.common.longitude;
				this.lat = obj.common.latitude;

				this.log.debug(`GetSystemData => longitude: ${this.lng} | latitude: ${this.lat}`);
			} else {
				this.log.error("system settings cannot be called up (Longitute, Latitude). Please check your ioBroker configuration!");
			}
		} catch (e) {
			this.log.error(`GetSystemData => system settings 'Latitude and Longitude' cannot be called up. Please check configuration!`);
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

			await helper.SetValueToObject(this.LightGroups, "All.anyOn",  (countGroups > 0) ? true : false);
			await helper.SetValueToObject(this.LightGroups, "All.power", (countGroups === groupLength) ? true : false);
			await this.setStateAsync("All.anyOn", this.LightGroups.All.anyOn, true);
			this.log.debug(`SetLightState => Set State "All.anyOn" to ${this.LightGroups.All.anyOn}`);
			await this.setStateAsync("All.power", this.LightGroups.All.power, true);
		} catch(e) {
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