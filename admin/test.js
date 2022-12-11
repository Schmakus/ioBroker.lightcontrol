const customObj = {
	common: {
  	    role: 'switch'
    }
};

const result = (customObj.common.role === 'color.level.temperature') ? 'ct' : (customObj.common.role === 'level.color.saturation') ? 'sat' : (customObj.common.role === 'level.dimmer') ? 'bri' : (customObj.common.role === 'level.color.temperature') ? 'ct' : (customObj.common.role === 'level.color.rgb') ? 'color' : (customObj.common.role === 'switch.mode.color') ? 'modeswitch' : (customObj.common.role === 'switch' ? 'power' : (customObj.common.role === 'switch.light') ? 'power' : 'power';

console.log(result);