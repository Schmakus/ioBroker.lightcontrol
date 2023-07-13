const params = {
	bri: ["oid", "minVal", "maxVal", "defaultBri", "useBri"],
	tt: ["oid", "minVal", "maxVal", "unit"],
	power: ["oid", "onVal", "offVal"],
	ct: ["oid", "minVal", "maxVal", "minValKelvin", "maxValKelvin", "sendCt", "CtConversion"],
	sat: ["oid", "minVal", "maxVal", "sendCt"],
	modeswitch: ["oid", "whiteModeVal", "colorModeVal", "sendModeswitch"],
	color: ["oid", "colorType", "defaultColor", "sendColor"],
};

module.exports = {
	params,
};
