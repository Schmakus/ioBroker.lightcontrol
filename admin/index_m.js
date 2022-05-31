// This will be called by the admin adapter when the settings page loads
function load(settings, onChange) {
	// example: select elements with id=key and class=value and insert value
	if (!settings) return;
	$(".value").each(function () {
		const $key = $(this);
		const id = $key.attr("id");
		if ($key.attr("type") === "checkbox") {
			// do not call onChange direct, because onChange could expect some arguments
			$key.prop("checked", settings[id])
				.on("change", () => onChange())
			;
		} else {
			// do not call onChange direct, because onChange could expect some arguments
			$key.val(settings[id])
				.on("change", () => onChange())
				.on("keyup", () => onChange())
			;
		}
	});
	onChange(false);

	// reinitialize all the Materialize labels on the page if you are dynamically adding inputs:
	if (M) M.updateTextFields();

	//++++++++++ TABS ++++++++++
	//Enhance Tabs with onShow-Function
	$("ul.tabs li a").on("click", function () { onTabShow($(this).attr("href")); });
	function onTabShow(tabId) {
		switch (tabId) {
			case "#tab-settings":
				loadOptions();
				break;
			case "#tab-general":
				loadOptions();
				break;
		}
	}
	//++++++++++ OPTIONS ++++++++++
	//Load Options
	function loadOptions() {
		$(".collapsible").collapsible();
		$(".modal").modal();
	}

	//+++++++++ SELECTS +++++++++++
	$("#GlobalLuxSensorPopUp").on("click", function () {
		initSelectId(function (sid) {
			sid.selectId("show", $("#GlobalLuxSensor").val(), function (newId) {
				if (newId) {
					$("#GlobalLuxSensor").val(newId).trigger("change");
				}
			});
		});
	});

	$("#GlobalLuxSensor").on("click", function() {
		const inputField = $(this);
		if (inputField.val() === "")
			initSelectId(function (sid) {
				sid.selectId("show", inputField.val(), function (newId) {
					if (newId) {
						inputField.val(newId).trigger("change");
					}
				});
			});
	});​

	$("#IsPresenceDpPopUp").on("click", function () {
		initSelectId(function (sid) {
			sid.selectId("show", $("#IsPresenceDp").val(), function (newId) {
				if (newId) {
					$("#IsPresenceDp").val(newId).trigger("change");
				}
			});
		});
	});
}

// This will be called by the admin adapter when the user presses the save button
function save(callback) {
	// example: select elements with class=value and build settings object
	const obj = {};
	$(".value").each(function () {
		const $this = $(this);
		if ($this.attr("type") === "checkbox") {
			obj[$this.attr("id")] = $this.prop("checked");
		} else if ($this.attr("type") === "number") {
			obj[$this.attr("id")] = parseFloat($this.val());
		} else {
			obj[$this.attr("id")] = $this.val();
		}
	});
	callback(obj);
}

let selectId;
function initSelectId(callback) {
	if (selectId) {
		return callback(selectId);
	}
	socket.emit("getObjects", function (err, objs) {
		selectId = $("#dialog-select-member").selectId("init", {
			noMultiselect: true,
			objects: objs,
			imgPath: "../../lib/css/fancytree/",
			filter: { type: "state" },
			name: "scenes-select-state",
			texts: {
				select: _("Select"),
				cancel: _("Cancel"),
				all: _("All"),
				id: _("ID"),
				name: _("Name"),
				role: _("Role"),
				room: _("Room"),
				value: _("Value"),
				selectid: _("Select ID"),
				from: _("From"),
				lc: _("Last changed"),
				ts: _("Time stamp"),
				wait: _("Processing..."),
				ack: _("Acknowledged"),
				selectAll: _("Select all"),
				unselectAll: _("Deselect all"),
				invertSelection: _("Invert selection")
			},
			columns: ["image", "name", "role", "room"]
		});
		callback(selectId);
	});
}