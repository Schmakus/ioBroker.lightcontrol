module.exports = {
	hue: {
		power: {
			cmd: "on",
			on: true,
			off: false,
		},
		bri: {
			cmd: "bri",
			min: 0,
			max: 254,
		},
		ct: {
			cmd: "ct",
			type: "mired",
			min: 153,
			max: 500,
		},
		color: {
			cmd: "xy",
			type: "xy",
			min: 0,
			max: 1,
		},
		colormode: {
			cmd: "colormode",
			ct: "ct",
			xy: "xy",
		},
		transitionTime: {
			cmd: "transition",
			type: "ms",
			min: 0,
			max: 65535,
		},
	},

	zigbee: {
		power: {
			cmd: "on",
			on: true,
			off: false,
		},
		bri: {
			cmd: "brightness",
			min: 0,
			max: 254,
		},
		ct: {
			cmd: "color_temp",
			type: "%",
			min: 0,
			max: 100,
		},
		color: {
			cmd: "color",
			type: "hex",
			min: "#000000",
			max: "#FFFFFF",
		},
		colormode: {
			cmd: "colormode",
			ct: "ct",
			xy: "xy",
		},
		transitionTime: {
			cmd: "transition",
			type: "s",
			min: 0,
			max: 65535,
		},
	},
};
