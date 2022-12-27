![Logo](admin/lightcontrol.png)

# ioBroker.lightcontrol

[![NPM version](https://img.shields.io/npm/v/iobroker.lightcontrol.svg)](https://www.npmjs.com/package/iobroker.lightcontrol)
[![Downloads](https://img.shields.io/npm/dm/iobroker.lightcontrol.svg)](https://www.npmjs.com/package/iobroker.lightcontrol)
![Number of Installations](https://iobroker.live/badges/lightcontrol-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/lightcontrol-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.lightcontrol.png?downloads=true)](https://nodei.co/npm/iobroker.lightcontrol/)

**Tests:** ![Test and Release](https://github.com/Schmakus/ioBroker.lightcontrol/workflows/Test%20and%20Release/badge.svg)

**Falls euch meine Arbeit gefällt:** [![Paypal Donation](https://img.shields.io/badge/paypal-donate%20%7C%20spenden-blue.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=PK89K4V2RBU78&source=url)

## LightControl adapter for ioBroker

Light control of lamps from various manufacturers

[Deutsche Beschreibung hier](docs/de/lightcontrol.md)

[English Description here](docs/en/lightcontrol.md) --> in Dev

## ToDo

-   Select more than one LightGroup for one Object-ID (Bug with jsonCustom Select multible)
-   Availability for notice with lower brighness and defined seconds before AutoOff
-   Set Ct, Sat and Color directly to the lamp, also if it's switched off.
-   Availability to switch on/off lights only with level/brightness state and without switch state

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**

	-   (Schmakus) Add: Set Ct, Sat and Color directly to the lamp, also if it's switched off.
-->

### **WORK IN PROGRESS**

-   (Schmakus) Deleting hole light from group if it contains no states
-   (Schmakus) Updating CreateState Function for extended debugging

### 0.0.4 (2022-12-23)

-   (Schmakus) Fix: Warning by adding motion sensor to group
-   (Schmakus) New: Add Default Values for WarmWhite and DayLight at Color-State
-   (Schmakus) updating translations

### 0.0.3 (2022-12-22)

-   (Schmakus) Fix: Moving sensors and lights to other group
-   (Schmakus) Fix: Adding sensor to groups
-   (Schmakus) Update German Docu

### 0.0.2 (2022-12-20)

-   (Schmakus) first Alpha Release

### 0.0.1 (2022-12-01)

-   (Schmakus) Initial Release

## License

MIT License

Copyright (c) 2022 Schmakus <schmakus@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
