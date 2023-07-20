const params = {
	bri: ["oid", "minVal", "maxVal", "defaultBri", "useBri"],
	tt: ["oid", "minVal", "maxVal", "unit"],
	power: ["oid", "onVal", "offVal"],
	ct: ["oid", "minVal", "maxVal", "minKelvin", "maxKelvin", "sendCt", "ctConversion"],
	sat: ["oid", "minVal", "maxVal", "sendCt"],
	modeswitch: ["oid", "whiteModeVal", "colorModeVal", "sendModeswitch"],
	color: ["oid", "colorType", "defaultColor", "sendColor", "setCtwithColor"],
};

module.exports = {
	params,
};
