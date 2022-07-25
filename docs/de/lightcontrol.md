![Logo](img/lightcontrol.png)
# LightControl
### *Steuerung von Lampen unterschiedlicher Hersteller* 


---

<a id="inhaltsverzeichnis"></a>
# Inhaltsverzeichnis 
* [1 Features](#1-features)
* [2 Installation](#2-installation)
* [3 Konfiguration](#3-konfiguration)
* [4 Haupteinstellungen - Startseite](#4-haupteinstellungen) 
  * [4.1 Aufbau der Tabelle](#41-aufbau-der-tabelle) 
  * [4.2 individuelle Konfiguration eines Bewässerungskreises](#42-individuelle-konfiguration-eines-bewsserungskreises) 
    * [4.2.1 Haupteinstellungen des Ventils](#421-haupteinstellungen-des-ventils)
      * [4.2.1.1 Bewässerungseinstellungen](#4211-bewasserungseinstellungen)
      * [4.2.1.2 Einschaltpunkt zum Gießen](#4212-einschaltpunkt)
        * [Berechnung der Verdunstung](#einschaltpunkt-berechnung)
        * [Bodenfeuchte-Sensor bistabil](#einschaltpunkt-bistabil)
        * [Bodenfeuchte-Sensor analog](#einschaltpunkt-analog)  
        * [Start an festen Wochentagen (ohne Sensoren)](#einschaltpunkt-feste-tage)
    * [4.2.2 Pumpeneinstellungen des Ventils](#422-pumpeneinstellungen-des-ventils) 
* [5 Pumpen-Einstellungen](#5-pumpen-einstellungen) 
* [6 Zeit-Einstellungen](#6-zeit-einstellungen) 
* [7 Zusätzliche-Einstellungen](#7-zustzliche-einstellungen) 
  * [7.1 Astro-Einstellungen](#71-astro-einstellungen) 
  * [7.2 Debug-Einstellungen](#72-debug-einstellungen) 
  * [7.3 Zusätzliche Benachrichtigungseinstellung](#73-zustzliche-benachrichtigungseinstellungen) 
  * [7.4 Sensoren zur Berechnung der Verdunstung](#74-sensoren-zur-berechnung-der-verdunstung) 
  * [7.5 Wettervorhersage](#75-wettervorhersage) 
* [8 Benachrichtigungen](#8-benachrichtigungen) 
  * [8.1 Telegram](#81-telegram) 
  * [8.2 Pushover](#82-pushover) 
  * [8.3 E-Mail](#83-e-mail) 
  * [8.4 WhatsApp](#84-whatsapp) 
* [9 Objekte](#9-objekte) 
  * [9.1 control](#91-control) 
  * [9.2 evaporation](#92-evaporation) 
  * [9.3 info](#93-info) 
  * [9.4 sprinkle](#94-sprinkle) 
* [10 Was ist für die Zukunft geplant](#10-was-ist-fr-die-zukunft-geplant) 


---


<a id="1-features"></a>
# 1. Features

* Gruppierung beliebig vieler Lampen/Leuchtmittel
* Verwendung gemischter Lampen/Farbsystemen und Umrechnung der Farbsysteme (Hex,Rgb,Hsl,Xy)
* Möglichkeit der Zuweisung von defaultwerten zu jedem Leuchtmittel (gleiche Helligkeit trotz unterschiedlich leistungsstarker Leuchtmittel)
* Verwendung beliebig vieler Bewegungsmelder pro Gruppe
* Ramping (langsame Änderung der Helligkeit bis Zielwert) für on und off
* Hoch- und Runterdimmen
* AutoOff nach Zeit / Kein Off bei Bewegung; 
* AutoOff nach Helligkeit
* AutoOn bei Bewegung ab bestimmter Helligkeit 
* AutoOn bei Dunkelheit
* AutoOn bei Anwesenheitszählererhöhung ab bestimmter Helligkeit (Begrüßungslicht bei heimkommen)
* Override on (Putzlicht)
* Masterswitch um alle Gruppen gemeinsam ein- und auszuschalten (Gleichzeitig Indikator, wenn alle Gruppen an sind)
* Info Datenpunkt für "beliebige Gruppe ist ein"
* Adaptive Helligkeit (Bei Aussenhelligkeit über 1000 Lux volle Helligkeit (100%), darunter linear dunkler bis 0 Lux (2%))
* Adaptive Farbtemperatur (4 dynamische Modi: Linear (linear ansteigend von Sonnenaufgang bis Sonnenmittag, dann linear abfallend bis Sonnenuntergang), Solar (entsprechend der Sonnenhöhe errechneter Sinus, maxCt ist Jahreszeitenabhängig), SolarInterpoliert (wie Solar, jedoch ohne Jahreszeitenabhängigkeit), StartYourDay (linear Absteigend von Start-Uhrzeit - Sonnenuntergang)  ![adaptive_Ct.png](/docs/de/img/adaptive_Ct.png) 

* Blinken (Alarm, Türklingel, etc.)

---
* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="2-installation"></a>
# 2. Installation

Der Adapter befindet sich in der Testphase und ist noch nicht bei ioBroker released. 
Um ihn installieren zu können muss man zu den Adapter von ioBroker gehen und über die "Katze" (Experteneinstellung) "Benutzerdefiniert" anklicken. 
Dann den Github-Link: [https://github.com/Schmakus/ioBroker.lightcontrol.git](https://github.com/Schmakus/ioBroker.lightcontrol.git) einfügen.

Nach dem Download kann man durch anklicken des (+) eine Instanz angelgen.

---
* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="3-konfiguration"></a>
# 3. Konfiguration

Sollte in dem Installationsfenster die Checkbox "***schließen, wenn fertig***" nicht angehakt sein muss man dieses natürlich noch schließen.

Das Konfigurationsfenster besteht aus den Reitern:
* [4. Gruppeneinstellungen](#4-gruppen-einstellungen)
* [5. Allgemeine Einstellungen](#5-allgemeine-einstellungen)

---
* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="4-gruppen-einstellungen"></a>
# 4. Gruppeneinstellungen

Das Konfigurationsfenster öffnet sich automatisch mit den Gruppeneinstellungen. Hier werden die einzelnen Lichtgruppen erstellt.

![main.png](img/mainwindow.jpg)

Mit Klick auf das + wird eine neue Gruppe erstellt. Erlaubtes Sonderzeichnen ist ausschließlich "_". 

![newGroup.jpg](img/newGroup.jpg)

Um eine Gruppe zu bearbeiten, klickt man auf den Gruppennamen. Es öffnet sich ein weiteres Menü.
Hier lassen sich die jeweiligen Lampen und Sensoren konfigurieren.

Mit "EDIT GROUPNAME" lässt sicher Gruppenname ändern.
Mit "REMOVE GROUP" kann die Gruppe gelöscht werden

![03_group_lights.jpg](img/03_group_lights.jpg)

* [4.1 Beleuchtung](#41-beleuchtung)
* [4.2 Sensoren](#42-sensoren)
* [4.3 Allgemeines](#43-allgemeines)


---


<a id="41-beleuchtung"></a>
## 4.1 Beleuchtung

Info: Eine Objekt-ID lässt sich durch Klick auf das + neben dem Eingabefeld auswählen oder kann direkt eingegeben werden.

Dabei bitte die Datenpunkte mit STATE (o. ä.) auswählen. NICHT das Gerät als solches.

![SelectID.jpg](img/SelectID.jpg)

**Power On/Off => Plichtfeld**

***Object-ID for Power On/Off*** – Die Objekt ID des Ein/Aus states der Lampe
***Value for On*** - Wert für Ein. z.B. true
***Value for Off*** - Wert für Aus. z.B. false

**Brightness Control** => Aktivieren über den Switch

***Object-ID for Brighness*** – Die Objekt ID für die Helligkeit der Lampe
***Value for minimum Brightness*** - Wert die geringste Helligkeit. z.B. 0
***Value for maximum Brightnes*** - Wert für die maximalste Helligkeit. z.B. 100
***Value/Offset for Brightness*** - Wert für die Anpassung der Helligkeit gegenüber den anderen Lampen innerhalb der Gruppe. 100 = keine Anpassung // 50 = Halb so hell

![06_lights_bri.jpg](img/06_lights_bri.jpg)


**aktiv** – Checkbox zur Aktivierung der Steuerung des entsprechenden Bewässerungskreises

**Name** – Name des Ventilkreises; (Dieser wird bei der Auswahl der ID automatisch aus den Objekten eingelesen. Dieser Name kann individuell angepasst werden. Es dürfen aber keine Duplikate vorkommen.)

**Objekt-ID-Sprinkler** – eindeutige ID des zu steuernden Datenpunkts in den Objekten

**(+)** – Hinzufügen/Ändern der ID

**Bleistift** – spezifische Konfiguration des jeweiligen Bewässerungskreises

**Pfeile** – verändern der Reihenfolge der verschiedenen Bewässerungskreise in der Tabelle

**Mülleimer** – Löschen der ID mit allen konfigurierten Daten!

---


<a id="42-individuelle-konfiguration-eines-bewsserungskreises"></a>
## 4.2. individuelle Konfiguration eines Bewässerungskreises

Diese Konfigurationsebene besteht aus zwei Reitern: [**Haupteinstellungen**](#421-haupteinstellungen-des-ventils) und [**Pumpeneinstellungen**](#422-pumpeneinstellungen-des-ventils)

---


<a id="421-haupteinstellungen-des-ventils"></a>
### 4.2.1. Haupteinstellungen des Ventils

![Ventil-Haupteinstellung.jpg](img/Ventil-Haupteinstellung.jpg)

---


<a id="4211-bewasserungseinstellungen"></a>
#### 4.2.1.1 Bewässerungseinstellungen

* **Bewässerungszeit in min** – Einstellung der Zeit zum Bewässern in Minuten
    > **Information** → Unter "Berechnung der Verdunstung“ und "Bodenfeuchte-Sensor analog“ wird die Bewässerungszeit verlängert je weiter der Trigger "niedrigster Prozentsatz der Bodenfeuchte“ unterschritten wurde.
    > Bei **Start an festen Wochentagen (ohne Sensoren)** und **Bodenfeuchte-Sensor bistabil** erfolgt die Verlängerung proportional der extraterrestrische Strahlung ihrer Region.
* **maximale Bewässerungsverlängerung in %** – Begrenzung der Bewässerungsdauer in Prozent (100 % = Bewässerungsdauer wird nicht verlängert)
    > **Information** → Bei **Start an festen Wochentagen (ohne Sensoren)** und **Bodenfeuchte-Sensor bistabil** wird hier die Verlängerung der Bewässerungszeit angegeben. Wobei am 21.12.
     die Bewässerungszeit gleich der Eingabe und am 21.6. gleich der maximalen Verlängerung entspricht. Dazwischen wird die Bewässerungszeit proportional der extraterrestrische Strahlung ihrer Region angepasst.
* **Bewässerungsintervall in min** – Die Bewässerungsdauer wird in einem Intervall aufgeteilt. (z. B. 5 min an, mindestens 5 min aus, 5 min an, usw.)
    > **Tipp** –> Ich habe bei der Autoauffahrt ein Rasengitter verlegt. Hier läuft das Wasser beim Bewässern einfach nur die Schräge herunter. Durch die Bewässerung in Intervallen konnte ich dem entgegenwirken.

---


<a id="4212-einschaltpunkt"></a>
#### 4.2.1.2 Einschaltpunkt zum Gießen

* Über **Methode zur Kontrolle der Bodenfeuchtigkeit** werden die verschiedenen Sensoren, zur Steuerung der Bewässerung und deren verhalten, festgelegt.
    > **Information** → Über [**„Zusätzliche Einstellungen" → „Wettervorhersage"**](#75-wettervorhersage) kann der Startvorgang verschoben werden, wenn es Regen soll. 

---

<a id="einschaltpunkt-berechnung"></a>
+ **Berechnung der Verdunstung** 
        
    ![verdunstung.jpg](img/verdunstung.jpg)

    + **Sensor im Gewächshaus** bei true (Auswahl) wird aktuelle Regenmenge und die Regenvorhersage nicht berücksichtigt
    + **Einschaltpunkt (Bodenfeuchte) der Bewässerungsventile in %** – Auslösetrigger: Wenn dieser Wert unterschritten wird, so beginnt zum Startzeitpunkt die Bewässerung.
    + **Bodenfeuchte = 100 % nach der Bewässerung** – bei Aktivierung, wird die Bodenfeuchte nach der Bewässerung auf 100 % gesetzt. Ansonsten bleibt sie knapp darunter Aufgrund der Verdunstung während der Bewässerung.

    ***maximale Bodenfeuchtigkeit***

    * **maximale Bodenfeuchte nach der Bewässerung in (mm)** – Max. Wassergehalt im Boden nach der Bewässerung.
        > **Tipp** –> Rasengitter: 5; Blumenbeet: 10; Rasenfläche: 14
    * **maximale Bodenfeuchte nach einem Regen in (mm)** – Max. Wassergehalt im Boden nach einem kräftigen Regen.
        > **Tipp** –> Rasengitter: 6; Blumenbeet: 15; Rasenfläche: 19

---

<a id="einschaltpunkt-bistabil"></a>
+ **Bodenfeuchte-Sensor bistabil** 

    ![bistabil.jpg](img/bistabil.jpg)

    + **Einschaltpunkt zum Gießen (Bodenfeuchte-Sensor → bistabil true(Bewässerung ein), false(Bewässerung aus))**

    + **Bodenfeuchte-Sensor** Auswahl des Sensors über das PLUS-Zeichen
    + **Sensor im Gewächshaus** bei true (Auswahl) wird die Regenvorhersage nicht berücksichtigt

---

<a id="einschaltpunkt-analog"></a>
+ **Bodenfeuchte-Sensor analog**

    ![analog.jpg](img/analog.jpg)

    **Einschaltpunkt zum Gießen (Berechnung der Verdunstung → analog interne Umrechnung in 0 - 100 %)**
    + **Methode zur Kontrolle der Bodenfeuchtigkeit** → Bodenfeuchte-Sensor analog
    + **Bodenfeuchte-Sensor** → Auswahl des Sensors über das PLUS-Zeichen
    + **Sensor im Gewächshaus** → bei true (Auswahl) wird die Regenvorhersage nicht berücksichtigt
    + **Einschaltpunkt (Bodenfeuchte) der Bewässerungsventile in %** → Auslösetrigger: Wenn dieser Wert unterschritten wird, so beginnt zum Startzeitpunkt die Bewässerung.

  #### Konfiguration des analogen Bodenfeuchte-Sensors

  * **analoger Bodenfeuchte-Sensor bei 0 Prozent (Sensor in der Luft)** → Wert des Sensors an der Luft hier eingeben! Sollte dieser unterschritten werden erfolgt eine Warnung im Protokoll(Debug)
  * **analoger Bodenfeuchte-Sensor bei 100 Prozent (Sensor im Wasser)** → Wert des Sensors im Wasser hier eingeben! Sollte dieser überschritten werden erfolgt eine Warnung im Protokoll(Debug)

---


+ **Start an festen Wochentagen (ohne Sensoren)** <a id="einschaltpunkt-feste-tage"></a>

    ![festeTage.jpg](img/festeTage.jpg)
    **Auswahl der Bewässerungstage in der Woche**
    + **Drei Tage Rhythmus** → Der 1. Tag der Bewässerung ist der Folgetag, nach dem Speichern der Konfiguration, und dann jeden 3. Tag in Folge.
    + **Jeden zweiten Tag** → Der 1. Tag der Bewässerung ist der Folgetag, nach dem Speichern der Konfiguration, und dann jeden 2. Tag in Folge.
    + **An festen Tagen starten** → Die Bewässerungstage werden individuell nach Wochentagen bestimmt.
    > **Info** → Die Bewässerungsdauer wird verlängert siehe [Bewässerungseinstellungen](#4211-bewasserungseinstellungen)
    
---


<a id="422-pumpeneinstellungen-des-ventils"></a>
### 4.2.2. Pumpeneinstellungen des Ventils

![Ventil-Pumpeneinstellung.jpg](img/Ventil-Pumpeneinstellung.jpg)

* **Durchflussmenge** → ermittelte Durchflussmenge des aktuellen Bewässerungskreises
    > **Tipp** → steht oft in der Bedienungsanleitung bzw. im Internet
* **Booster** → nimmt alle aktiven Bewässerungskreise für 30 s vom Netz und schaltet sie danach wieder zu
    > **Tipp** → Meine Pumpe liefert max. 1800 l/h und meine Rasensprenger benötigen 1400 l/h, aber den vollen Druck zum Herausfahren. Mit der Booster Funktion kann ich nebenbei noch die Koniferen bewässern die nur 300 l/h benötigen.
    >> **Achtung** → Mit dieser Funktion sollte man sehr sparsam umgehen, da immer nur ein Bewässerungskreis mit aktiven Booster bewässern kann.    

---


* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="5-pumpen-einstellungen"></a>
# 5. Pumpen-Einstellungen
Hier werden die Einstellung der Hauptpumpe (Grundwasser), einer zweiten Pumpe (Zisterne) und der Spannungsversorgung der Regelkreise vorgenommen.

![Pumpeneinstellung.jpg](img/Pumpeneinstellung.jpg)

* **Einstellung der Ventile**

    * **Steuerspannung der Ventile** → Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie das STATE für die Steuerspannung der Ventile auswählen.
    Dieser Ausgang ist aktive, so wie eines der Ventile aktive ist.
    * **maximaler Parallelbetrieb der Ventile** → Hier kann die Anzahl der aktiven Ventile begrenzt werden. z. B. wenn die Leistung des Steuertrafos nicht ausreicht, mehrere Ventile parallel zu schalten. 
    * **Schaltabstand zwischen den Ventilen in ms** – Eingabe einer Zeit in Millisekunden. Diese ist die Wartezeit, bis zum Schalten des nächsten Ventils damit nicht z. B. 6 Ausgänge auf einmal schalten.
    
* **Einstellung der Pumpe**
    * **Hauptpumpe: ** → Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier wird das STATE der Pumpe hinterlegt, welche für die Wasserversorgung zuständig ist.
    * **maximale Pumpenleistung der Hauptpumpe in l/h: ** → Hier wird die maximale Pumpenleistung hinterlegt. Diese begrenzt dann die Bewässerungskreise, damit noch genügend Druck an den Ventilen ansteht.
        > **Achtung** → Hier muss die tatsächliche Pumpenleistung angegeben werden, nicht die vom Typenschild. Ich habe z. B. eine "Gardena 5000/5 LCD" diese schafft aber nur 1800l auf grund der Leitungslänge und nicht 4500l/h, wie auf dem Typenschild angegeben.  

* **Zisternenpumpe in Vorrangschaltung hinzufügen**
    * **Zisternenpumpe** → Hier wird die Pumpe der Zisterne eingetragen. Diese wird deaktiviert, so wie der Füllstand der Zisterne zu gering ist. Wobei die Hauptpumpe, in diesem Fall, die Bewässerung fortsetzt.
    * **maximale Pumpenleistung der Zisterne in l / h** → Hier wird die maximale Pumpenleistung hinterlegt. Diese begrenzt dann die Bewässerungskreise, damit noch genügend Druck an den Ventilen ansteht.
        > **Achtung** → Hier muss die tatsächliche Pumpenleistung angegeben werden, nicht die vom Typenschild. Ich habe z. B. eine "Gardena 5000/5 LCD" diese schafft aber nur 1800l auf grund der Leitungslänge und nicht 4500l/h, wie auf dem Typenschild angegeben. 
    * **Füllhöhe der Zisterne** → Angabe des Füllstandsensors für die Ermittlung der Füllhöhe in %.
        > **eingebaut** → Hm-Sen-Wa-Od kapazitiver Füllstandmesser von HomeMatic.
    * **Mindestfüllstand der Zysten in %** → Schaltpunkt, bei dessen Unterschreitung wird auf die Hauptpumpe umgeschaltet und bei laufender Bewässerung die Ventile je Verbrauchsmenge angepasst.
    
---


* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="6-zeit-einstellungen"></a>
# 6. Zeit-Einstellungen
In diesem Abschnitt wird die Startzeiten von SprinkleControl festgelegt.

![Zeiteinstellung.jpg](img/Zeiteinstellung.jpg)

## Einstellungen für die Startzeit
* **Beginnen Sie mit einer festen Startzeit** – Bei dieser Auswahl startet die Bewässerung zu einer festgelegten, unter "Startzeit in der Woche" festgelegten Zeit.
    * **Startzeit in der Woche** – Angabe der Startzeit in der Woche.
* **Startzeit bei Sonnenaufgang** – Wenn sie diese Option auswählen, so startet die Bewässerung bei Sonnenaufgang. Diese Zeit kann aber noch unter Zeitverschiebung variiert werden.
    * **Zeitverschiebung** – Eingabe der Zeitverschiebung bei Sonnenaufgang. (+/- 120 min)
* **Startzeit am Ende der goldenen Stunde** – Hier startet die Bewässerung zum Ende der Golden Hour.

---


## Einstellungen für die Startzeit am Wochenende
* **andere Startzeit am Wochenende** – Soll die Bewässerung am Wochenende zu einer anderen Zeit starten (um z. B. den Nachbarn nicht zu verärgern), so kann man es hier aktivieren.
    * **Startzeit am Wochenende** – Startzeit für das Wochenende.

---


## Einstellung für die Startzeit an Feiertagen
* **Startzeit der Feiertage wie am Wochenende** – Wenn an Feiertagen auch wie am Wochenende die Bewässerung starten soll, so kann es hier aktiviert werden.
    * **Feiertage Instanz** – Hier muss dann aber noch die externe Feiertagsinstanz ausgewählt werden. (z. B. der Adapter "Deutsche Feiertage")
    
---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="7-zustzliche-einstellungen"></a>
# 7. Zusätzliche-Einstellungen

In den Extra-Einstellungen werden verschiedene Einstellungen eingegeben, die bei der Berechnung der Verdunstung unerlässlich sind.

![Extraeinstellungen.jpg](img/Extraeinstellungen.jpg)

---


<a id="71-astro-einstellungen"></a>
## 7.1 Astro-Einstellungen
* **Breiten- und Längengrad**
  Breiten- und Längengrad übernimmt SprinkleControl aus den ioBroker Systemeinstellungen.
  SprinkleControl berechnet anhand dieser Werte den Sonnenstand.

---


<a id="72-debug-einstellungen"></a>
## 7.2 Debug-Einstellungen

* **debuggen**
  Durch Aktivierung werden im Log zusätzliche Informationen angezeigt, wodurch Fehler schneller ermittelt werden können.

---


<a id="73-zustzliche-benachrichtigungseinstellungen"></a>
## 7.3 Zusätzliche Benachrichtigungseinstellungen

* **Benachrichtigungen aktivieren / deaktivieren**
  Einschalten des Reiters Benachrichtigungen. Hier werden dann die Einstellungen zur Kommunikation vorgenommen.

---


<a id="74-sensoren-zur-berechnung-der-verdunstung"></a>
## 7.4. Sensoren zur Berechnung der Verdunstung
> **Achtung** → Das Program ist auf die Sensoren der Homematic HmIP-SWO-PL zur Berechnung der Verdunstung abgestimmt!
> > **Andere mir bekannte verwendete Wetterstationen** → Eurochron Funk-Wetterstation EFWS 2900 mit Sainlogic Adapter.

![verdunstDiagra.jpg](img/verdunstDiagra.jpg)

Über die Sensoren wird die max. mögliche Verdunstung der pot. Evapotranspiration nach Penman ETp berechnet und zur Steuerung der Bewässerungsanlage genutzt.
Dies geschieht jedes Mal, wenn die Temperatur sich ändert.
> **Achtung** → Zur Berechnung werden der Verdunstung Werden die Sensoren der Temperatur, der Feuchtigkeit, der Windgeschwindigkeit und der Helligkeit herangezogen. 
Diese müssen unbedingt für die Steuerung der Bewässerung über die „Berechnung der Verdunstung" verfügbar sein.

* **Temperatursensor** – Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie die ID des Luftsensors in °C auswählen.
* **Feuchtigkeitssensor** – Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie die ID des Feuchtigkeitssensors in % auswählen.
* **Windgeschwindigkeitssensor** – Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie die ID des Windgeschwindigkeitssensors in km/h auswählen.
* **Helligkeitssensor** – Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie die ID des Helligkeitssensors auswählen.
* **Regensensor** – Durch anklicken des (+) Symbols öffnet sich das Select-ID State Fenster. Hier können sie die ID des Zählers der Regenmenge in mm auswählen.

---


<a id="75-wettervorhersage"></a>
## 7.5 Wettervorhersage

Beim Aktivieren des Feldes "Wettervorhersage verwenden", erscheint ein Auswahlfeld. In diesem muss die Instanz vom Adapter "Das Wetter" ausgewählt werden.
Im Adapter "Das Wetter“ muss der "Pfad 2: XML-Datei mit 5-Tage-Wettervorhersage und detaillierten Informationen für alle 3 Stunden" ausgefüllt sein, 
damit SprinkleControl auf das Objekt **„daswetter.0.NextDaysDetailed.Location_1.Day_1.rain_value"** zugreifen kann. Dieser Wert wird dann bei jedem Start im Automatikmodus zur Entscheidung einer Beregnung verwendet.
* **Niederschlags-Schwellwert in mm** → Erst wenn dieser Wert von der Regenvorhersage überschritten wird, so wird diese berücksichtigt.

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="8-benachrichtigungen"></a>
# 8 Benachrichtigungen

## Auswahl der Benachrichtigung
* **Benachrichtigungstyp** → Auswahl des Benachrichtigungsweges
  * [Telegram](#81-telegram) 
  * [Pushover](#82-pushover) 
  * [E-Mail](#83-e-mail) 
  * [Whatsapp](#84-whatsapp)
    
---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

--- 


<a id="81-telegram"></a>
### 8.1 Telegram
 
![Telegram.jpg](img/Telegram.jpg)
* **Telegraminstanz** – Instanz des Telegram-Adapters auswählen 
* **Telegramempfänger** – Telegram Empfänger auswählen
  > **Achtung** → Der Adapter muss laufen, damit ein Empfänger angezeigt und ausgewählt werden kann.
* **Benachrichtigungsstil** Umfang des Benachrichtigungstextes 
    + kurze Benachrichtigung → nur Startvorgänge 
    + Lange Benachrichtigung → umfangreiche Benachrichtigungen 
* **Warten auf den Versand (Sekunden)** – warten bis zum Versand 
* **Stille Nachricht** – Benachrichtigungston aus 
* **Benachrichtigung nur bei Fehlern** – noch nicht in Benutzung  

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="82-pushover"></a>
### 8.2 Pushover
 
![Pushover.jpg](img/Pushover.jpg)
* **Pushover-Instanz** – Instanz des Pushover-Adapters auswählen
* **Benachrichtigungsstil** Umfang des Benachrichtigungstextes
    + kurze Benachrichtigung → nur Startvorgänge
    + Lange Benachrichtigung → umfangreiche Benachrichtigungen
* **Warten auf den Versand (Sekunden)** – warten bis zum Versand
* **Geräte-ID (optional)** Geräte-ID eingeben (optional)
* **Benachrichtigungston** – Benachrichtigungston auswählen
* **Stille Nachricht** – Benachrichtigungston aus
* **Benachrichtigung nur bei Fehlern** – noch nicht in Benutzung

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="83-e-mail"></a>
### 8.3 E-Mail
 
![E-Mail.jpg](img/E-Mail.jpg)
* **E-Mail-Empfänger** – Empfänger der E-Mail
* **E-Mail-Absender** – Absender der E-Mail
* **E-Mail-Instanz** – Instanz des E-Mail-Adapters auswählen
* **Benachrichtigungsstil** Umfang des Benachrichtigungstextes
    + kurze Benachrichtigung → nur Startvorgänge
    + Lange Benachrichtigung → umfangreiche Benachrichtigungen
* **Warten auf den Versand (Sekunden)** warten bis zum Versand
* **Benachrichtigung nur bei Fehlern** – noch nicht in Benutzung

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="84-whatsapp"></a>
### 8.4 WhatsApp
 
![WhatsApp.jpg](img/WhatsApp.jpg)
* **WhatsApp-Instanz** – Instanz des WhatsApp-Adapters auswählen
* **Benachrichtigungsstil** Umfang des Benachrichtigungstextes
    + kurze Benachrichtigung → nur Startvorgänge
    + Lange Benachrichtigung → umfangreiche Benachrichtigungen
* **Warten auf den Versand (Sekunden)** – warten bis zum Versand
* **Benachrichtigung nur bei Fehlern** – noch nicht in Benutzung

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---

<a id="9-objekte"></a>
# 9 Objekte
![control.jpg](img/control.jpg)

---


<a id="91-control"></a>
## 9.1 control
* **Holiday** - Wenn Holiday auf true gesetzt wird, so wird die Bewässerung wie am Wochenende gestartet. Falls die Wochenendeinstellung aktiviert wurde. Die Verbindung mit einem Kalender wäre hier auch möglich.
* **autoOnOff** – Bei Einstellung "off“ ist der Automatikbetrieb der Bewässerungsanlage deaktiviert.
* **parallelOfMax** – z. B. (3 : 4) Drei Bewässerungskreise sind von vier möglichen aktive. (Dies ist nur eine Anzeige!)
* **restFlow** – Anzeige der noch möglichen Restfördermenge der Pumpe. (Dies ist nur eine Anzeige!)

---


<a id="92-evaporation"></a>
## 9.2 evaporation
Ich habe mich zur Berechnung der Verdunstung nach der Formel für die Berechnung der mittleren monatlichen Verdunstung nach Penman gerichtet. Dies ist für mich ausreichend, obwohl sie nicht zu 100 % umgesetzt wurde.
* **ETpCurrent** – Dies ist dei aktuelle Verdunstung als Tageswert.
* **ETpToday** – Hier wird die aktuelle Tagesverdunstung angezeigt. Diese wird in der Nacht um 0:05 zur ETpYesterday verschoben und dann wieder auf 0 gesetzt.
* **ETpYesterday** – ist die Anzeige der Verdunstung des gestrigen Tages.

---


<a id="93-info"></a>
## 9.3 info
* **cisternState** – Anzeige vom Status der Zisterne und deren Zustände, wenn sie vorhanden ist.
* **nextAutoStart** – Anzeige des nächsten Starts der Bewässerungsanlage.
* **rainToday** – aktueller Niederschlag des heutigen Tages
* **rainTomorrow** – Niederschlagsmenge des morgigen Tages

---


<a id="94-sprinkle"></a>
## 9.4 sprinkle
* **Auffahrt** – Ort des Geschehens (wurde in der Config unter Haupteinstellung → Name so individuell benannt)
  * **history**
    * **curCalWeekConsumed** – aktueller wöchentlicher Verbrauch in Liter des Beregnungskreises
    * **curCalWeekRunningTime** – aktuelle wöchentliche Gesamtlaufzeit des Beregnungskreises
    * **lastCalWeekConsumed** – letzter wöchentlicher Verbrauch in Liter des Beregnungskreises
    * **lastCalWeekRunningTime** – letzte wöchentliche Gesamtlaufzeit des Beregnungskreises
    * **lastConsumed** – Wasserverbrauch bei der letzten Bewässerung in Liter
    * **lastOn** – letzter Start des Beregnungskreises (05.07 14:14)
    * **lastRunningTime** – letzte Bewässerungsdauer
  * **actualSoilMoisture**
    * **Berechnung der Verdunstung** – aktuelle virtuelle Bodenfeuchte in % (max. 100 % nach der Beregnung, >100 % nach einem kräftigen Regen) (hat mit der tatsächlichen nichts zu tun)
    * **Bodenfeuchte-Sensor analog** - Zustand des Sensors true/false
    * **Bodenfeuchte-Sensor bistabil** – aktuelle virtuelle Bodenfeuchte in % (max. 100 % nach der Beregnung, >100 % nach einem kräftigen Regen) (hat mit der tatsächlichen nichts zu tun)
    * **Start an festen Wochentagen (ohne Sensoren)** - Anzeige des nächsten Starttermins z. B. Mon, Thu, Wed  
* **autoOn** - Automatik ein (Hier könnt ihr die automatische Bewässerung dieses Kreises ausschalten, z. B. bei einer Reparatur, wobei manuelles Bewässern jederzeit möglich ist.)
  * **countdown** – Restzeit des Beregnungskreises
  * **runningTime** – Laufzeit des Beregnungskreises
    - wenn hier eine Zahl > 0 eingegeben wird, so startet der Beregnungskreises für die angegebene Zeit in Minuten
    - bei eingabe einer 0 wird die Bewässerung des Beregnungskreises beendet
  * **sprinklerState** – Anzeige des Zustandes des Beregnungskreises
    - 0:off; => Beregnungskreis aus
    - 1: wait; → Beregnungskreis wartet auf eine frei werdende Kapazität der Pumpe
    - 2: on; → Beregnungskreis ein
    - 3: break; → Beregnungskreis wurde unterbrochen (Configuration, Intervall Beregnung)
    - 4: Boost; → Boost-Funktion des aktuellen Beregnungskreises ist aktiv (Configuration, Booster ein)
    - 5: off(Boost) → Beregnungskreis für 30 s unterbrochen, da eine Boost-Funktion aktive ist

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---


<a id="10-was-ist-fr-die-zukunft-geplant"></a>
# 10 Was ist für die Zukunft geplant
+ Das wichtigste haben wir jetzt erst einmal. Mal sehen, was mir noch so einfällt.
+ Die Visualisierung, die ich früher noch plante, werde ich nicht weiter verfolgen. 

---

* [zurück zum Inhaltsverzeichnis](#inhaltsverzeichnis)

---