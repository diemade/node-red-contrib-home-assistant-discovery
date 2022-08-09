module.exports = function (RED) {
  "use strict";

  const Helper = require("../lib/discovery-helper");

  function HADiscovery(config) {
    RED.nodes.createNode(this, config);

    let broker = RED.nodes.getNode(config.server);
    if (!broker) return;

    let node = this;
    node.config = config;
    node.broker = broker;

    node.devices = [];
    node.devices_values = {};

    let getTopic = () => {
      return (node.config?.topic ?? "").replace(/[\/+#]+$/g, "");
    };

    let buildTopic = (path) => {
      return getTopic() + (path ?? "");
    };

    let parserTopic = (topic) => {
      // <discovery_prefix>/<component>/[<node_id>/]<object_id>/config
      // Home Assistant
      // homeassistant/binary_sensor/garden/config
      // Esphome
      // homeassistant/binary_sensor/bathroom-fan/status/config
      // zigbee2mqtt
      // homeassistant/binary_sensor/0x00158d000392b2df/contact/config
      let parts = topic.split("/");

      if (parts.length === 4) {
        return {
          prefix: parts[0],
          component: parts[1],
          node_id: "",
          object_id: parts[2],
          last: parts[3],
        };
      }

      return {
        prefix: parts[0],
        component: parts[1],
        node_id: parts[2],
        object_id: parts[3],
        last: parts[4],
      };
    };

    let isConfigTopic = (topic) => {
      let parts = parserTopic(topic);
      return parts.prefix == getTopic() && parts.last == "config";
    };

    let getComponentTopic = (topic) => {
      let parts = parserTopic(topic);
      return parts.component;
    };

    let setStatus = (device) => {
      return node.devices_values[device?.avty_t] ?? null;
    };

    let setValue = (device) => {
      let re_json = /^{{\s*?value_json\.([\w|-|\.]+)\s*?}}$/i;
      let payload = {};

      // sensor or switch
      if (device.component == "sensor" || device.component == "switch") {
        // "val_tpl": "{{ value_json.contact }}"
        if ("val_tpl" in device) {
          let value_json = device.val_tpl.match(re_json)[1];
          payload = node.devices_values[device?.stat_t]?.[value_json] ?? null;
        } else {
          payload = node.devices_values[device?.stat_t] ?? null;
        }
      }

      return payload;
    };

    node.getDevices = (callback, refresh = false) => {
      let count = 0;
      let watchdog = null;
      let timeout = null;

      let onMessageConfig = (topic, message) => {
        if (!isConfigTopic(topic)) return;

        let payload = message.toString();
        payload = Helper.isJson(payload) ? JSON.parse(payload) : payload;

        if (typeof payload !== "object") return;

        let device = Helper.long2shot(payload);
        // +bad hack for z2m
        if (Array.isArray(device?.dev?.ids)) {
          device.dev.ids = device.dev.ids[0];
        }
        if (Array.isArray(device?.avty)) {
          device.avty_t = device.avty[0]["topic"];
          delete device.avty;
        }
        // -bad hack for z2m

        // build device
        device.component = getComponentTopic(topic);
        device.current_status = setStatus(device);
        device.current_value = setValue(device);
        device.homekit = Helper.payload2homekit(device);

        // push only support component
        if (device.component == "sensor" || device.component == "switch") {
          node.devices.push(device);
        }
        count++;
      };

      let _done = () => {
        if (node.broker?.client) {
          node.broker?.client?.unsubscribe(buildTopic("/#"));
          node.broker?.client?.removeListener("message", onMessageConfig);
        }
        clearInterval(watchdog);
        clearTimeout(timeout);
      };

      if (refresh || node.devices?.length === 0) {
        node.log("MQTT fetch devices ...");

        node.devices = [];

        node.broker?.client?.subscribe(buildTopic("/#"));
        node.broker?.client?.on("message", onMessageConfig);

        let last = 0;
        watchdog = setInterval(() => {
          if (count == last) {
            _done();
            if (typeof callback === "function") {
              callback(node.devices);
            }
            return node.devices;
          }
          count = last;
        }, 0.5 * 1000);

        timeout = setTimeout(() => {
          _done();
          node.error(
            'Error: getDevices timeout, unsubscribe "' + buildTopic("/#") + '"'
          );
        }, 5 * 1000);
      } else {
        node.log("MQTT cache devices ...");
        if (typeof callback === "function") {
          callback(node.devices);
        }
        return node.devices;
      }
    };

    let onConnect = () => {
      node.getDevices(() => {
        node.broker?.client?.subscribe("#");
      }, true);
    };

    let getKeyByValue = (obj, val) => {
      return Object.keys(obj).find((key) => obj[key] === val);
    };

    let onMessage = (topic, message) => {
      if (isConfigTopic(topic)) return;

      let payload = message.toString();
      payload = Helper.isJson(payload) ? JSON.parse(payload) : payload;

      // save value
      node.devices_values[topic] = payload;

      for (let i in node.devices) {
        let key = getKeyByValue(node.devices[i], topic);
        if (!key) continue;

        // set value device
        node.devices[i].current_status = setStatus(node.devices[i]);
        node.devices[i].current_value = setValue(node.devices[i]);
        node.devices[i].homekit = Helper.payload2homekit(node.devices[i]);

        node.emit("onMessage", node.devices[i]);
      }
    };

    node.broker?.register(this);
    node.broker?.client?.on("connect", onConnect);
    node.broker?.client?.on("message", onMessage);

    node.on("close", () => {
      if (node.broker?.client) {
        node.broker?.client?.removeListener("connect", onConnect);
        node.broker?.client?.removeListener("message", onMessage);
      }
    });
  }

  RED.nodes.registerType("ha-discovery", HADiscovery);
};
