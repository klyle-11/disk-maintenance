"""A stand-in Linux tray for CI, speaking StatusNotifierItem like
Raspberry Pi OS's wf-panel-pi, KDE or Xfce do.

  sni_tray.py serve          be the tray (StatusNotifierWatcher + host);
                             prints ITEM <bus name><path> for each icon
  sni_tray.py click LABEL    click LABEL in the registered icon's menu

Needs the system Python's dbus and gi modules (python3-dbus, python3-gi).
"""
import sys

import dbus
import dbus.mainloop.glib
import dbus.service

WATCHER = "org.kde.StatusNotifierWatcher"


def serve():
    from gi.repository import GLib

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    items = []

    class Watcher(dbus.service.Object):
        @dbus.service.method(WATCHER, in_signature="s", sender_keyword="sender")
        def RegisterStatusNotifierItem(self, service, sender=None):
            # appindicator registers by object path; the sender is the bus name.
            item = sender + service if service.startswith("/") else service
            items.append(item)
            print("ITEM", item, flush=True)
            self.StatusNotifierItemRegistered(item)

        @dbus.service.method(WATCHER, in_signature="s")
        def RegisterStatusNotifierHost(self, service):
            pass

        @dbus.service.signal(WATCHER, signature="s")
        def StatusNotifierItemRegistered(self, item):
            pass

        @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="ss", out_signature="v")
        def Get(self, iface, prop):
            return self.GetAll(iface)[prop]

        @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
        def GetAll(self, iface):
            return {
                "IsStatusNotifierHostRegistered": dbus.Boolean(True),
                "ProtocolVersion": dbus.Int32(0),
                "RegisteredStatusNotifierItems": dbus.Array(items, signature="s"),
            }

    name = dbus.service.BusName(WATCHER, bus)  # noqa: F841 (keeps the name)
    Watcher(bus, "/StatusNotifierWatcher")
    print("TRAY UP", flush=True)
    GLib.MainLoop().run()


def click(label):
    bus = dbus.SessionBus()
    watcher = bus.get_object(WATCHER, "/StatusNotifierWatcher")
    item = watcher.Get(WATCHER, "RegisteredStatusNotifierItems", dbus_interface=dbus.PROPERTIES_IFACE)[-1]
    name, _, path = item.partition("/")
    icon = bus.get_object(name, "/" + path)
    menu_path = icon.Get("org.kde.StatusNotifierItem", "Menu", dbus_interface=dbus.PROPERTIES_IFACE)
    menu = dbus.Interface(bus.get_object(name, menu_path), "com.canonical.dbusmenu")
    _, layout = menu.GetLayout(0, -1, ["label"])

    def walk(node):
        node_id, props, children = node
        yield int(node_id), str(props.get("label", "")).replace("_", "")
        for child in children:
            yield from walk(child)

    for node_id, text in walk(layout):
        if text == label:
            menu.Event(node_id, "clicked", dbus.Int32(0), dbus.UInt32(0))
            print("CLICKED", label)
            return
    sys.exit(f"No menu item {label!r} in {[t for _, t in walk(layout)]}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["serve"]:
        serve()
    elif sys.argv[1:2] == ["click"] and len(sys.argv) == 3:
        click(sys.argv[2])
    else:
        sys.exit(__doc__)
