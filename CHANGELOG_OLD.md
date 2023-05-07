# Older changes
## 0.2.9 (2023-04-29)

-   (Schmakus) Important Update! Dev-mode was activated in v0.2.8

## 0.2.8 (2023-04-28)

-   (Schmakus) Fix switch on/off
-   (Schmakus) Some code improvements

## 0.2.7 (2023-04-20)

-   (Schmakus) Fix switching on/off

## 0.2.6 (2023-04-19)

-   (Schmakus) Creating LightGroups is only possible if the group name does not contain any special characters other than \_ and -.

## 0.2.5 (2023-04-19)

-   (Schmakus) Fix: set brightness although no brightness state is available (blink)

## 0.2.4 (2023-04-17)

-   (Schmakus) renew release. no changes. please use this release.

## 0.2.3 (2023-04-17)

-   (Schmakus) No special characters allowed in group names except dashes and underlines => Please change your group names if needed!!!

## 0.2.2 (2023-04-17)

-   (Schmakus) Fix: Create Groups without any global lux-sensor or individial lux-sensor
-   (Schmakus) Update dependencies
-   (Schmakus) Enhancements for better debugging

## 0.2.1 (2023-03-21)

-   (Schmakus) Fix calculation of color-temperature and added ct-reverse mode ([#96] [#89])
-   (Schmakus) Added brightness converting. Now you can use brighness states with 0-254 or 0-100
-   (Schmakus) some little bugfixes

## 0.2.0 (2023-02-20)

-   (Schmakus) Availability to switch on/off lights only with level/brightness state and without switch state
-   (Schmakus) Availability to set Ct, Sat and Color directly to the lamp, also if it's switched off.
-   (Schmakus) Added new Modus for AdaptiveCt: StartYourDay interplated. It's a sinus half curve from morning time to sunset.
-   (Schmakus) Update adaptername translations in io-package.json
-   (Schmakus) Some little bugfixes and corrections for logging
-   (Schmakus) Fix AdaptiveCt, because there was a problem with date object.

## 0.1.3 (2023-01-17)

-   (Schmakus) Added AdaptiveCt functionality. Was not implemented in older versions.

## 0.1.2 (2023-01-14)

-   (Schmakus) Some different small bugfixes and code cleaning
-   (Schmakus) Fix: Update for ioBroker Beta-Repo
-   (Schmakus) Fix: Adaptive Color-Temperature (failure by reading settings minCt and maxCt)

## 0.1.1 (2023-01-04)

-   (Schmakus) Availability to switch on/off lights only with level/brightness state and without switch state
-   (Schmakus) Add Sentry Plugin
-   (Schmakus) Fix issue [#80](https://github.com/Schmakus/ioBroker.lightcontrol/issues/80)
-   (Schmakus) general translation updates and translation of states

## 0.1.0 (2023-01-02)

-   (Schmakus) Latest Release

## 0.0.8 (2023-01-02)

-   (Schmakus) Ability to remove unused lights and sensors when deleting the light group
-   (Schmakus) Some code cleaning and update debug logs
-   (Schmakus) Update dependencies
-   (Schmakus) Update translations

## 0.0.6 (2022-12-29)

-   (Schmakus) New: [#61](https://github.com/Schmakus/ioBroker.lightcontrol/issues/61) Added infinite blinking. Please read the documentation.
-   (Schmakus) Fix: some little things.

## 0.0.5 (2022-12-27)

-   (Schmakus) Fix: [#66](https://github.com/Schmakus/ioBroker.lightcontrol/issues/66) Adding more than one lamp to group
-   (Schmakus) Fix: CustomConfig Color definitions
-   (Schmakus) Deleting hole light from group if it contains no states
-   (Schmakus) Updating CreateState Function for extended debugging

## 0.0.4 (2022-12-23)

-   (Schmakus) Fix: Warning by adding motion sensor to group
-   (Schmakus) New: Add Default Values for WarmWhite and DayLight at Color-State
-   (Schmakus) updating translations

## 0.0.3 (2022-12-22)

-   (Schmakus) Fix: Moving sensors and lights to other group
-   (Schmakus) Fix: Adding sensor to groups
-   (Schmakus) Update German Docu

## 0.0.2 (2022-12-20)

-   (Schmakus) first Alpha Release

## 0.0.1 (2022-12-01)

-   (Schmakus) Initial Release
