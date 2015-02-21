/**
 * Author: Martin Richard <martius@martiusweb.net>
 * This code is free software, licensed under GNU/LGPL (as are gnome
 * libraries).
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const MessageTray = imports.ui.messageTray;
const St = imports.gi.St;
const Util = imports.misc.util;

// Duration of the blink effect in seconds
const BLINK_DURATION = 2;

// Blink frequency in Hz
const BLINK_FREQUENCY = 8;

// Max abnormal stops of the daemon
const MAX_ABNORMAL_STOPS = 3;

// Message levels
const Levels = ["_normal", "success", "notice", "info", "warn", "critical", "error"];
const Urgency = {
    "notice": MessageTray.Urgency.NORMAL,
    "info": MessageTray.Urgency.NORMAL,
    "success": MessageTray.Urgency.NORMAL,
    "warn": MessageTray.Urgency.HIGH,
    "critical": MessageTray.Urgency.CRITICAL,
    "error": MessageTray.Urgency.CRITICAL,
}

// DBus interface
const dbus_iface = '<node> \
<interface name="com.alwaysdata.status"> \
<method name="notify"> \
    <arg name="level" type="s" direction="in"/> \
    <arg name="body" type="s" direction="in"/> \
</method> \
</interface> \
</node>';


const adStatusBus = new Lang.Class({
    Name: 'adStatusBus',

    _init: function(ui) {
        this.ui = ui;
        this.enabled = false;

        this.dbus_impl = Gio.DBusExportedObject.wrapJSObject(dbus_iface, this);
    },

    enable: function() {
        if(this.enabled) {
            return;
        }

        this.dbus_impl.export(Gio.DBus.session, '/com/alwaysdata/status');
        this.enabled = true;
    },

    disable: function() {
        if(!this.enabled) {
            return;
        }

        this.dbus_impl.unexport();
        Gio.DBus.session.unown_name(this.dbus_id);
        this.enabled = true;
    },

    notify: function(level, body) {
        this.ui.page(level, body);
    },
});

const adStatusUi = new Lang.Class({
    Name: "adStatusUi",

    _init: function() {
        this._current_level = 0;
        this._blinking = false;
        this._blinking_handle = 0;
    },

    enable: function() {
        this._source = new MessageTray.Source("alwaysdata", "emblem-important");
        this._addPanelIcon();
    },

    disable: function() {
        this.resetLevel();
        this._removePanelIcon();
        this._source.destroy();
        this._source = null;
    },

    _addPanelIcon: function() {
        this._button = new St.Bin({style_class: 'panel-button',
                                   reactive: true,
                                   can_focus: true,
                                   x_fill: true,
                                   y_fill: false,
                                   track_hover: true });

        // let icon = new St.Icon({icon_name: 'software-update-urgent-symbolic',
        let icon = new St.Icon({icon_name: 'software-update-available-symbolic',
                                style_class: 'system-status-icon'});

        this._button.set_child(icon);
        Main.panel._rightBox.insert_child_at_index(this._button, 0);
        this._button.connect('button-press-event', Lang.bind(this, this._buttonPressed));
    },

    _removePanelIcon: function() {
        Main.panel._rightBox.remove_child(this._button);
    },

    _buttonPressed: function() {
        // Testing
        if(this._current_level == 0) {
            this.page("warn", "Test warn!");
        }
        else {
            this.page("critical", "Test critical!");
        }
    },

    page: function(level, message) {
        this.setLevel(level);

        if(!Main.messageTray.contains(this._source)) {
            Main.messageTray.add(this._source);
        }

        let params, notification;
        if(level == "critical" || level == "error") {
            params = {'soundFile': '/usr/share/sounds/KDE-Sys-App-Negative.ogg'};
        }
        else if(level == "success") {
            params = {'soundFile': '/usr/share/sounds/KDE-Sys-App-Positive.ogg'};
        }

        notification = new MessageTray.Notification(this._source,
                                                    "alwaysdata status",
                                                    message, params);
        notification.setUrgency(Urgency[level]);
        this._source.notify(notification);
    },

    setLevel: function(level) {
        let level_int = Levels.indexOf(level);

        if(level_int > 0 && level_int >= this._current_level) {
            this.resetLevel();
            this._current_level = level_int;
            this._makePanelBlink();
        }
    },

    resetLevel: function() {
        this._current_level = 0;

        if(this._blinking) {
            this._cancelBlinking();
        }

        Levels.forEach(function(level) {
            Main.panel._removeStyleClassName('ad-' + level);
        });
    },

    _makePanelBlink: function() {
        if(this._blinking) {
            this._cancelBlinking();
        }

        let css_class = 'ad-' + Levels[this._current_level],
            period = 1000 / BLINK_FREQUENCY,
            remaining_time = BLINK_DURATION * 1000,
            blink_on, blink_off;

        blink_on = Lang.bind(this, function() {
            Main.panel._addStyleClassName(css_class);
            remaining_time -= period * 2;
            if(remaining_time > 0) {
                this._blinking_handle = Main.Mainloop.timeout_add(period, blink_off);
            }
            else {
                this._blinking_handle = 0;
                this._blinking = false;
            }
        });

        blink_off = Lang.bind(this, function() {
            Main.panel._removeStyleClassName(css_class);
            this._blinking_handle = Main.Mainloop.timeout_add(period, blink_on);
        });

        this._blinking = true;
        blink_on();
    },

    _cancelBlinking: function() {
        if(!this._blinking) {
            return;
        }

        Main.Mainloop.source_remove(this._blinking_handle);
        this._blinking_handle = 0;
        this._blinking = false;
    },
});

const adXMPPDaemon = new Lang.Class({
    Name: "adXMPPDaemon",

    _init: function(ui) {
        this.ui = ui;
        this.started = false;
        this.nb_abnormal_stop = 0;
        this.stop_called = false;
        this.pid = null;
    },

    start: function(notify) {
        let sucess, argv, pid;

        [success, argv] = GLib.shell_parse_argv(
            'python ' + Me.path + '/ad-xmpp-watcher/xmppwatcher.py')

        try {
            // See gnome-js/misc/util.js:trySpawn
            let flags = (GLib.SpawnFlags.SEARCH_PATH |
                         GLib.SpawnFlags.DO_NOT_REAP_CHILD);
            [success, pid] = GLib.spawn_async(null, argv, null, flags, null);
        }
        catch(err) {
            if (err instanceof GLib.Error) {
                // Reformat error message
                let message = err.message.replace(/.*\((.+)\)/, '$1');
                throw new (err.constructor)({code: err.code, message: message});
            } else {
                throw err;
            }
        }

        // Watch when the process terminates
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid,
                             Lang.bind(this, this.on_termination));
        this.pid = pid;
        this.started = success;

        if(notify) {
            this.ui.page('success', 'XMPP Daemon running');
        }
    },

    stop: function() {
        if(!this.started) {
            return;
        }

        this.nb_abnormal_stop = 0;
        this.stop_called = true;
        Util.spawn(['kill', '' + this.pid])
    },

    on_termination: function() {
        this.started = false;
        this.pid = null;

        // did we call stop or was it a mistake?
        if(!this.stop_called) {
            // It doesn't look like a normal stop, we should restart the daemon
            this.nb_abnormal_stop++;

            if(this.nb_abnormal_stop >= MAX_ABNORMAL_STOPS) {
                this.ui.page("warning", "XMPP Daemon is not running, check the logs");
                return;
            }
            this.start(true);
        }
        this.stop_called = false;
    },
});

let ad_status_ui, dbus_server, daemon;

function init() {
    ad_status_ui = new adStatusUi();
    dbus_server = new adStatusBus(ad_status_ui);
    daemon = new adXMPPDaemon(ad_status_ui);
}

function enable() {
    dbus_server.enable();
    ad_status_ui.enable();
    // The daemon must be started after the dbus server
    daemon.start();
}

function disable() {
    daemon.stop();
    ad_status_ui.disable();
    dbus_server.disable();
}
