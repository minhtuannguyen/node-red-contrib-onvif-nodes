/**
 * Copyright 2018 Bart Butenaers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
 module.exports = function(RED) {
    var settings = RED.settings;
    const onvif = require('onvif');
    const utils = require('./utils');
    
    function OnVifEventsNode(config) {
        RED.nodes.createNode(this, config);
        this.action = config.action;

        var node = this;
        
        // Retrieve the config node, where the device is configured
        node.deviceConfig = RED.nodes.getNode(config.deviceConfig);
        
        if (node.deviceConfig) {
            node.listener = function(onvifStatus) {
                utils.setNodeStatus(node, 'event', onvifStatus);
                
                if (onvifStatus !== "connected" && node.eventListener) {
                    // When the device isn't connected anymore, stop listening to events from the camera
                    node.deviceConfig.cam.removeListener('event', node.eventListener);
                    node.eventListener = null;
                }
            }
            
            // Start listening for Onvif config nodes status changes
            node.deviceConfig.addListener("onvif_status", node.listener);
            
            // Show the current Onvif config node status already
            utils.setNodeStatus(node, 'event', node.deviceConfig.onvifStatus);
            
            node.deviceConfig.initialize();
        }
               
        node.on("input", function(msg) {  
            var newMsg = {};
            
            // Note: the node's config screen has no 'action' input field yet ...
            var action = node.action || msg.action;
            
            if (!action) {
                // When no action specified in the node, it should be specified in the msg.action
                node.error("No action specified (in node or msg)");
                return;
            }
            
            // Don't perform these checks when e.g. the device is currently disconnected (because then e.g. no capabilities are loaded yet)
            if (action !== "reconnect") {
                if (!node.deviceConfig || node.deviceConfig.onvifStatus != "connected") {
                    node.error("This node is not connected to a device");
                    return;
                }

                if (!utils.hasService(node.deviceConfig.cam, 'event')) {
                    node.error("The device has no support for an event service");
                    return;
                }
            }
            
            // Seems that some Axis cams support pull point, although they return WSPullPointSupport 'false'
            /*if (!node.deviceConfig.cam.capabilities.events.WSPullPointSupport == true) {
                //console.warn('Ignoring input message since the device does not support pull point subscription');
                return;
            }*/
            
            newMsg.xaddr = this.deviceConfig.xaddress;
            newMsg.action = action;

            try {
                switch (action) {
                    case "start":
                        if (node.eventListener) {
                            node.error("This node is already listening to device events");
                            return;
                        }
                        
                        // Overwrite the device status text
                        node.status({fill:"green",shape:"dot",text:"listening"});

                        // Per-topic state for debounce and watchdog timer
                        node.eventDebounceTimers  = {};  // short debounce: batch simultaneous cell events
                        node.eventWatchdogTimers  = {};  // long watchdog: detect motion stopped
                        node.eventMotionActive    = {};  // tracks whether motion is currently active
                        node.eventBatchHasTrue    = {};  // tracks if any event in debounce window had detection:true
                        node.eventBatchActive     = {};  // tracks if a debounce timer is currently running
                        
                        node.eventListener = function(camMessage) {
                            // Strip namespaces from topic (e.g. tns1:RuleEngine/tns1:PeopleDetector/People)
                            var parts = camMessage.topic._.split('/');
                            var eventTopic = '';
                            for (var i = 0; i < parts.length; i++) {
                                eventTopic += (i ? '/' : '') + parts[i].split(':').pop();
                            }

                            // Performance early-exit: once a batch has a confirmed true detection
                            // and motion is already reported as active, skip all further parsing.
                            // The debounce timer already running will reset the watchdog.
                            if (node.eventBatchActive[eventTopic] &&
                                node.eventBatchHasTrue[eventTopic] &&
                                node.eventMotionActive[eventTopic]) {
                                return;
                            }

                            var outputMsg = {
                                topic: eventTopic,
                                payload: {
                                    detected: null,
                                    time: camMessage.message.message.$.UtcTime,
                                    property: camMessage.message.message.$.PropertyOperation
                                }
                            };

                            // Only handle simpleItem
                            // Only handle one 'source' item
                            // Ignore the 'key' item  (nothing I own produces it)
                            // Handle all the 'Data' items

                            // SOURCE (Name:Value)
                            if (camMessage.message.message.source && camMessage.message.message.source.simpleItem) {
                                if (Array.isArray(camMessage.message.message.source.simpleItem)) {
                                    // TODO : currently we only process the first event source item ...
                                    outputMsg.payload.source = {
                                        name:  camMessage.message.message.source.simpleItem[0].$.Name,
                                        value: camMessage.message.message.source.simpleItem[0].$.Value
                                    }
                                }
                                else {
                                    outputMsg.payload.source = {
                                        name: camMessage.message.message.source.simpleItem.$.Name,
                                        value: camMessage.message.message.source.simpleItem.$.Value
                                    }
                                }
                            }

                            //KEY
                            if (camMessage.message.message.key) {
                                outputMsg.payload.key = camMessage.message.message.key;
                            }

                            // DATA (Name:Value)
                            if (camMessage.message.message.data && camMessage.message.message.data.simpleItem) {
                                if (Array.isArray(camMessage.message.message.data.simpleItem)) {
                                    outputMsg.payload.data = [];
                                    for (var x  = 0; x < camMessage.message.message.data.simpleItem.length; x++) {
                                        outputMsg.payload.data.push({
                                            name: camMessage.message.message.data.simpleItem[x].$.Name,
                                            value: camMessage.message.message.data.simpleItem[x].$.Value
                                        })
                                    }
                                }
                                else {
                                    outputMsg.payload.data = {
                                        name: camMessage.message.message.data.simpleItem.$.Name,
                                        value: camMessage.message.message.data.simpleItem.$.Value
                                    }
                                }
                            }
                            else if (camMessage.message.message.data && camMessage.message.message.data.elementItem) {
                                outputMsg.payload.data = {
                                    name: 'elementItem',
                                    value: JSON.stringify(camMessage.message.message.data.elementItem)
                                }
                            }

                            // Resolve the raw detection value from data (single item or first of array)
                            var rawDetected = outputMsg.payload.data
                                ? (Array.isArray(outputMsg.payload.data)
                                    ? outputMsg.payload.data[0].value
                                    : outputMsg.payload.data.value)
                                : false;

                            // Use topic as the deduplication key (all grid cells share the same topic)
                            var cacheKey = eventTopic;

                            if (outputMsg.payload.property === 'Changed') {
                                // Standard camera: "Changed" events carry the real boolean value.
                                // Deduplicate: only forward if the value actually changed.
                                var motionNow = !!rawDetected;
                                if (node.eventMotionActive[cacheKey] !== motionNow) {
                                    node.eventMotionActive[cacheKey] = motionNow;
                                    outputMsg.payload.detected = motionNow;
                                    node.send(outputMsg);
                                }
                            } else {
                                // Non-standard camera (e.g. Tapo C225, sends only "Initialized" events
                                // continuously while motion is active, never "Changed" events).
                                // Strategy:
                                //   - Track if ANY event in a 300ms window has a true detection value
                                //   - Emit ONE message (detected:true) when detection starts
                                //   - Reset a 5s watchdog on every batch; fire detected:false when silent
                                if (rawDetected === true) {
                                    node.eventBatchHasTrue[cacheKey] = true;
                                }
                                // Only start ONE debounce timer per batch window
                                if (!node.eventBatchActive[cacheKey]) {
                                    node.eventBatchActive[cacheKey] = true;
                                    var batchMsg = outputMsg;
                                    node.eventDebounceTimers[cacheKey] = setTimeout(function() {
                                        node.eventBatchActive[cacheKey] = false;
                                        var detected = node.eventBatchHasTrue[cacheKey];
                                        node.eventBatchHasTrue[cacheKey] = false;

                                        if (detected && !node.eventMotionActive[cacheKey]) {
                                            // First detection in this presence window: emit once
                                            node.eventMotionActive[cacheKey] = true;
                                            batchMsg.payload.detected = true;
                                            node.send(batchMsg);
                                        }

                                        if (node.eventMotionActive[cacheKey]) {
                                            // Reset watchdog — camera sends every ~1s while active;
                                            // 5s silence means the person has left
                                            clearTimeout(node.eventWatchdogTimers[cacheKey]);
                                            node.eventWatchdogTimers[cacheKey] = setTimeout(function() {
                                                node.eventMotionActive[cacheKey] = false;
                                                node.send({ topic: eventTopic, payload: { detected: false, property: 'timeout' } });
                                            }, 5000);
                                        }
                                    }, 300);
                                }
                            }
                        }
                        
                        // Start listening to events from the camera
                        node.deviceConfig.cam.on('event', node.eventListener);
                        break;
                    case "stop":
                        if (!node.eventListener) {
                            node.error("This node was not listening to events anyway");
                            return;
                        }

                        // Stop listening to events from the camera
                        node.deviceConfig.cam.removeListener('event', node.eventListener);
                        node.eventListener = null;

                        // Clear all debounce and watchdog timers
                        Object.values(node.eventDebounceTimers || {}).forEach(clearTimeout);
                        Object.values(node.eventWatchdogTimers || {}).forEach(clearTimeout);
                        node.eventDebounceTimers = {};
                        node.eventWatchdogTimers = {};
                        node.eventMotionActive   = {};
                        node.eventBatchHasTrue   = {};
                        node.eventBatchActive    = {};
                        
                        // Overwrite the device status text
                        node.status({fill:"green",shape:"ring",text:"not listening"}); 
                        break;               
                    case "getEventProperties":
                        node.deviceConfig.cam.getEventProperties(function(err, date, xml) {
                            if (!err) {
                                var simplifiedDate = {};
                                
                                // Simplify the soap message to a compact message, by keeping only all relevant information
                                function simplifyNode(node, simplifiedDateChild) {
                                    // loop over all the child nodes in this node
                                    for (const child in node) {
                                        switch (child) {
                                            case "$":
                                                // Continue to the next child in the list (same level)
                                                continue;
                                            case "messageDescription":
                                                // Collect the details that belong to the event
                                                var source = '';
                                                var date = '';
                                                
                                                if (node[child].source && node[child].source.simpleItemDescription) {
                                                    simplifiedDateChild.source = node[child].source.simpleItemDescription.$;
                                                }
                                                if (node[child].data && node[child].data.simpleItemDescriptio) {
                                                    simplifiedDateChild.date = node[child].data.simpleItemDescription.$;
                                                }
                                                
                                                return;
                                            default:
                                                // Decend recursively into the child node, looking for the messageDescription
                                                simplifiedDateChild[child] = {};
                                                simplifyNode(node[child], simplifiedDateChild[child]);
                                        }
                                    }
                                }
                                simplifyNode(date.topicSet, simplifiedDate)
                            }
                            
                            utils.handleResult(node, err, simplifiedDate, null, newMsg);
                        });
                        break;
                    case "getEventServiceCapabilities":
                        node.deviceConfig.cam.getEventServiceCapabilities(function(err, date, xml) {
                            utils.handleResult(node, err, date, xml, newMsg);
                        });
                        break;
                    case "reconnect":
                        node.deviceConfig.cam.connect(function(err) {
                            utils.handleResult(node, err, "", null, newMsg);
                        });
                        break
                    default:
                        //node.status({fill:"red",shape:"dot",text: "unsupported action"});
                        node.error("Action " + action + " is not supported");                   
                }
            }
            catch (exc) {
                node.error("Action " + action + " failed: " + exc);
            }
        });
        
        node.on("close",function() { 
            if (node.listener) {
                node.deviceConfig.removeListener("onvif_status", node.listener);
            }
            
            // Stop listening to events from the camera
            if (node.eventListener) {
                node.deviceConfig.cam.removeListener('event', node.eventListener);
                node.eventListener = null;
            }
        });
    }
    RED.nodes.registerType("onvif-events",OnVifEventsNode);
}
