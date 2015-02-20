# coding: utf-8
"""
Author: Martin Richard <martius@martiusweb.net>
This code is free software, licensed under GNU/LGPL.
"""

import argparse
import logging
import sys

import dbus

import settings

if not settings.validate_certificate:
    sys.modules['pyasn1'] = None
    sys.modules['pyasn1_modules'] = None

import sleekxmpp  # NOQA import must be done after pyans1 is disabled


class MessageEmitter:
    def __init__(self):
        self.session = dbus.SessionBus()
        proxy = self.session.get_object('org.gnome.Shell',
                                        '/com/alwaysdata/status')
        self.interface = dbus.Interface(proxy, 'com.alwaysdata.status')

        logging.debug("DBus proxy is ready")

    def close(self):
        self.session.close()

    def notify(self, level, message):
        self.interface.notify(level, message)


class RoomsWatcher(sleekxmpp.ClientXMPP):
    def __init__(self, emitter, settings):
        super().__init__(settings.user, settings.password)

        self.emitter = emitter
        self.settings = settings

        self._add_local_handlers('session_start', 'message')
        self.register_plugin("xep_0045")  # Multi-user room

    @property
    def muc(self):
        return self.plugin['xep_0045']

    @property
    def nickname(self):
        return self.settings.user.split('@', 1)[0]

    def _add_local_handlers(self, *events):
        for event in events:
            self.add_event_handler(event, getattr(self, 'on_' + event))

    def connect(self, address=None, *args, **kwargs):
        if not address and settings.host:
            address = (settings.host, settings.port)

        return super().connect(address, *args, **kwargs)

    def on_session_start(self, event):
        self.send_presence('dnd', pstatus="I am a bot")
        self.get_roster()

        # join rooms
        for room in self.settings.rooms:
            self.muc.joinMUC(room, self.nickname, password=self.settings.password, wait=True)
            logging.info('Joined room "%s"', room)

    def on_message(self, message):
        if message['type'] in ('chat', 'normal'):
            if message['from'].local in self.settings.bots:
                self.on_bot_message(message['from'].local, message['body'])
        elif message['type'] == 'groupchat':
            author = message['from'].resource or message['from'].local

            if author in self.settings.bots:
                self.on_bot_message(author, message['body'])

    def on_bot_message(self, author, body):
        print(author, "SAID:", body)

        try:
            self.emitter('error', "{}: {}".format(author, body))
        except Exception:
            logging.exception("Failed to send dbus message")


def main():
    parser = argparse.ArgumentParser(description="Daemon watching messages on XMPP rooms")
    parser.add_argument('-f', '--debug', help='set logging level to DEBUG',
                        action='store_const', dest='loglevel',
                        const=logging.DEBUG, default=logging.INFO)
    parser.add_argument('-v', '--verbose', help='set logging level to DEBUG',
                        action='store_const', dest='loglevel',
                        const=5, default=logging.INFO)

    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(level=args.loglevel, format="%(levelname)8s %(message)s")

    # TODO argparse verbose, copy echo_client, it's okay
    emitter = MessageEmitter()

    watcher = RoomsWatcher(emitter, settings)
    watcher.connect()
    watcher.process(block=True)

if __name__ == "__main__":
    main()
