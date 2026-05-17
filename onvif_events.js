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
        // Watchdog timeout in ms — must exceed camera's event batch interval.
        // Default 30s; configurable so users can tune per camera.
        this.motionTimeout = Math.max(5, (parseInt(config.motionTimeout, 10) || 30)) * 1000;

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
                            // Camera is alive — reset reconnect backoff so next offline period starts fresh.
                            node.eventReconnectDelay = 30000;

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
                                //   - Reset watchdog immediately on first event of each new batch
                                //     (prevents race: watchdog and next batch arriving at the same ms)
                                //   - Emit ONE message (detected:true) when detection starts
                                //   - 10s watchdog fires detected:false when camera goes silent
                                if (rawDetected === true) {
                                    node.eventBatchHasTrue[cacheKey] = true;
                                }
                                // Only start ONE debounce timer per batch window
                                if (!node.eventBatchActive[cacheKey]) {
                                    node.eventBatchActive[cacheKey] = true;
                                    var batchMsg = outputMsg;

                                    // If motion is already active, reset the watchdog NOW (on the
                                    // first event of this batch) rather than waiting 300ms for the
                                    // debounce. This prevents the watchdog firing at the same moment
                                    // as the next batch when the camera's batch interval ≈ watchdog.
                                    if (node.eventMotionActive[cacheKey]) {
                                        clearTimeout(node.eventWatchdogTimers[cacheKey]);
                                        node.eventWatchdogTimers[cacheKey] = setTimeout(function() {
                                            node.eventMotionActive[cacheKey] = false;
                                            node.send({ topic: eventTopic, payload: { detected: false, property: 'timeout' } });
                                        }, node.motionTimeout);
                                    }

                                    node.eventDebounceTimers[cacheKey] = setTimeout(function() {
                                        node.eventBatchActive[cacheKey] = false;
                                        var detected = node.eventBatchHasTrue[cacheKey];
                                        node.eventBatchHasTrue[cacheKey] = false;

                                        if (detected && !node.eventMotionActive[cacheKey]) {
                                            // First detection in this presence window: emit once
                                            // and start the watchdog for the first time.
                                            node.eventMotionActive[cacheKey] = true;
                                            batchMsg.payload.detected = true;
                                            node.send(batchMsg);
                                            clearTimeout(node.eventWatchdogTimers[cacheKey]);
                                            node.eventWatchdogTimers[cacheKey] = setTimeout(function() {
                                                node.eventMotionActive[cacheKey] = false;
                                                node.send({ topic: eventTopic, payload: { detected: false, property: 'timeout' } });
                                            }, node.motionTimeout);
                                        }
                                    }, 300);
                                }
                            }
                        }
                        
                        node.eventListeningActive = true;
                        // Exponential backoff delay for eventsError reconnects (30s → 60s → 120s cap).
                        // Reset to 30s whenever the camera successfully delivers an event.
                        node.eventReconnectDelay = 30000;

                        // When the camera goes offline (e.g. Tapo privacy ON), the onvif
                        // library's _restartEventRequest fires ~89 rapid retries (starting at
                        // 10ms, growing 1.111× each time up to 2 min) — enough to overwhelm
                        // the C225's embedded HTTP server and cause it to freeze.
                        // Fix: remove our 'event' listener on the first error so the library's
                        // next retry (~10ms away) sees 0 listeners and self-terminates.
                        // We then re-add the listener with exponential backoff:
                        //   30s → 60s → 120s (cap) — ~16 retries per 8h overnight.
                        node.eventsErrorListener = function(err) {
                            if (!node.eventListeningActive) return;
                            node.deviceConfig.cam.removeListener('event', node.eventListener);
                            var delay = node.eventReconnectDelay;
                            node.eventReconnectDelay = Math.min(node.eventReconnectDelay * 2, 120000);
                            node.status({fill:"yellow", shape:"ring", text:"camera offline, retry in " + Math.round(delay / 1000) + "s"});
                            node.warn('ONVIF camera offline (' + (err && err.message || err) + '), retrying in ' + Math.round(delay / 1000) + 's');
                            clearTimeout(node.eventReconnectTimer);
                            node.eventReconnectTimer = setTimeout(function() {
                                if (!node.eventListeningActive) return;
                                node.status({fill:"yellow", shape:"dot", text:"reconnecting..."});
                                node.deviceConfig.cam.on('event', node.eventListener);
                                // Kick the pull loop in case the library does not auto-start
                                // when a listener is re-added after it previously stopped.
                                if (typeof node.deviceConfig.cam._eventRequest === 'function') {
                                    node.deviceConfig.cam._eventRequest();
                                }
                            }, delay);
                        };
                        node.deviceConfig.cam.on('eventsError', node.eventsErrorListener);

                        // Start listening to events from the camera
                        node.deviceConfig.cam.on('event', node.eventListener);
                        break;
                    case "stop":
                        if (!node.eventListener) {
                            node.error("This node was not listening to events anyway");
                            return;
                        }

                        // Stop the error-driven reconnect loop and clean up error listener.
                        node.eventListeningActive = false;
                        clearTimeout(node.eventReconnectTimer);
                        if (node.eventsErrorListener) {
                            node.deviceConfig.cam.removeListener('eventsError', node.eventsErrorListener);
                            node.eventsErrorListener = null;
                        }

                        // Remove the JS listener and eagerly unsubscribe so the camera
                        // frees the pull-point subscription immediately (rather than
                        // waiting up to MessageTimeout seconds for the in-flight
                        // PullMessages request to return).
                        node.deviceConfig.cam.removeListener('event', node.eventListener);
                        node.eventListener = null;

                        if (node.deviceConfig.cam.events && node.deviceConfig.cam.events.subscription) {
                            node.deviceConfig.cam.unsubscribe(function(err) {
                                if (err) { node.warn('ONVIF unsubscribe: ' + err.message); }
                            });
                        }

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

            // Stop the error-driven reconnect loop and clean up
            node.eventListeningActive = false;
            clearTimeout(node.eventReconnectTimer);
            if (node.eventsErrorListener && node.deviceConfig) {
                node.deviceConfig.cam.removeListener('eventsError', node.eventsErrorListener);
                node.eventsErrorListener = null;
            }

            // Stop listening to events from the camera
            if (node.eventListener && node.deviceConfig) {
                node.deviceConfig.cam.removeListener('event', node.eventListener);
                node.eventListener = null;
            }
        });
    }
    RED.nodes.registerType("onvif-events",OnVifEventsNode);
}
