/**
 * (C) Roger Hardiman <opensource@rjh.org.uk>
 * First Release - May 2018
 * Licenced with the MIT Licence
 *
 * Perform a brute force scan of the network looking for ONVIF devices
 * For each device, save the make and model and a snapshot in the audit folder
 *
 * Can also use ONVIF Discovery to trigger the scan
 */

var IPADDRESS = '192.168.1.1-192.168.1.254', // single address or a range
    PORT = '80',
    USERNAME = 'onvifusername',
    PASSWORD = 'onvifpassword';

var onvif = require('onvif');
var Cam = onvif.Cam;
var flow = require('nimble');
var args = require('commander');
var fs = require('fs');
var dateTime = require('node-datetime');
var path = require('path');
var xml2js = require('xml2js')
var stripPrefix = require('xml2js').processors.stripPrefix;



// Show Version
var version = require('./package.json').version;
args.version(version);
args.description('ONVIF Camera Audit');
args.option('-f, --filename <value>', 'Filename of JSON file with IP Address List');
args.option('-i, --ipaddress <value>', 'IP Address (x.x.x.x) or IP Address Range (x.x.x.x-y.y.y.y)');
args.option('-P, --port <value>', 'ONVIF Port. Default 80');
args.option('-u, --username <value>', 'ONVIF Username');
args.option('-p, --password <value>', 'ONVIF Password');
args.option('-s, --scan', 'Discover Network devices on local subnet');
args.parse(process.argv);

if (!args) {
    args.help();
    process.exit(1);

}

if (!args.filename && !args.ipaddress && !args.scan) {
    console.log('Requires either a Filename (-f) or an IP Address/IP Range (-i) or a Scan (-s)');
    console.log('Use -h for details');
    process.exit(1);
}

let time_now = dateTime.create();
let folder = 'onvif_audit_report_' + time_now.format('Y_m_d_H_M_S');

try {
    fs.mkdirSync(folder);
} catch (e) {
    console.log('Unable to create log folder')
    process.exit(1)
}


if (args.ipaddress) {
    // Connection Details and IP Address supplied in the Command Line
    IPADDRESS = args.ipaddress;
    if (args.port) PORT = args.port;
    if (args.username) USERNAME = args.username;
    if (args.password) PASSWORD = args.password;


    // Perform an Audit of all the cameras in the IP address Range
    perform_audit(IPADDRESS, PORT, USERNAME, PASSWORD, folder);
}

if (args.filename) {
    // Connection details supplied in a .JSON file
    let contents = fs.readFileSync(args.filename);
    let file = JSON.parse(contents);

    if (file.cameralist && file.cameralist.length > 0) {
        // process each item in the camera list
        //Note - forEach is asynchronous - you don't know when it has completed
        file.cameralist.forEach(function (item) {
            // check IP range start and end
            if (item.ipaddress) IPADDRESS = item.ipaddress;
            if (item.port) PORT = item.port;
            if (item.username) USERNAME = item.username;
            if (item.password) PASSWORD = item.password;

            perform_audit(IPADDRESS, PORT, USERNAME, PASSWORD, folder);
        }
        );
    }
}

if (args.scan) {
    console.log("Probing for 5 seconds");

    let scanResults = [];

    // set up an event handler which is called for each device discovered
    onvif.Discovery.on('device', function (cam, rinfo, xml) {
        // function will be called as soon as the NVT responses

        /* Filter out xml name spaces */
        xml = xml.replace(/xmlns([^=]*?)=(".*?")/g, '');

        let parser = new xml2js.Parser({
            attrkey: 'attr',
            charkey: 'payload',                // this ensures the payload is called .payload regardless of whether the XML Tags have Attributes or not
            explicitCharkey: true,
            tagNameProcessors: [stripPrefix]   // strip namespace eg tt:Data -> Data
        });
        parser.parseString(xml,
            function (err, result) {
                if (err) return;

                // By default xml2js will return different json structures depending on whether there are 'attributes' in the XML
                // For example <MyTag value="123">HELLO</MyTag> will return value=123 as the '$ field and HELLO as the '_' field
                // For example <MyTag>HELLO</MyTag> does not use the '$' or '_' fields.
                // To make things easier to handle, we use parser options to place the data we want in a 'payload' field

                let urn = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['EndpointReference'][0]['Address'][0].payload.trim();
                let xaddrs = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['XAddrs'][0].payload.trim(); // Axis add whitespace on end. Remove it.
                let scopes = result['Envelope']['Body'][0]['ProbeMatches'][0]['ProbeMatch'][0]['Scopes'][0].payload.trim(); // Axis add whitespace on end. Remove it.
                scopes = scopes.split(" ");

                let hardware = "";
                let name = "";
                for (let i = 0; i < scopes.length; i++) {
                    // use decodeUri to conver %20 to ' '
                    if (scopes[i].includes('onvif://www.onvif.org/name')) name = decodeURI(scopes[i].substring(27));
                    if (scopes[i].includes('onvif://www.onvif.org/hardware')) hardware = decodeURI(scopes[i].substring(31));
                }

                process.stdout.write(".");

                const newItem = {
                    rinfo,
                    name,
                    hardware,
                    xaddrs,
                    urn,
                    scopes
                };
		scanResults.push(newItem);
            }
        );

    })
    onvif.Discovery.on('error', function (err) {
        // ignore discovery errors
    })

    // start the probe
    // resolve=false  means Do not create Cam objects
    onvif.Discovery.probe({ resolve: false }, function() {
        // completion callback
        process.stdout.write("\n");

        // sort the Scan Results by IP Address
        scanResults.sort((a,b) => { 
            // Check we are matching IPv4 against IPv6. If so sort IPv4 first
            if (a.rinfo.family < b.rinfo.family)
                return -1;
            else if (a.rinfo.family > b.rinfo.family)
                return 1;
            else {
                // A and B are both the same "family" (IPv4 or IPv6)

                if (a.rinfo.family == 'IPv4') {
                    // IPv4 - sort numerically
                    return toLong(a.rinfo.address) - toLong(b.rinfo.address);
                }
                else if (a.rinfo.family == 'IPv6') {
                    // IPv6 - sort by String. Could be improved
                    if (a.rinfo.address < b.rinfo.address) return -1;
                    else if (a.rinfo.address > b.rinfo.address) return 1;
                    else return 0;
                }
                else {
                    // Unknown IP family
                    return 0;
                }
            }
        });

        for(const item of scanResults) {
            let msg = item.rinfo.address + ' (' + item.name + ') (' + item.hardware + ') (' + item.xaddrs + ') (' + item.urn + ')';
            console.log(msg);
        }
        console.log("Total " + scanResults.length);
    });

}


// program ends here (just functions below)


function perform_audit(ip_addresses, port, username, password, folder) {

    let ip_list = [];

    // Valid IP addresses are
    // a) Single address 1.2.3.4
    // b) Range 10.10.10.50-10.10.10.99
    // c) List 1.1.1.1,2.2.2.2,3.3.3.3
    // d) Mixture 1.2.3.4,10.10.10.50-10.10.10.99

    ip_addresses = ip_addresses.split(',');
    for (let i = 0; i < ip_addresses.length; i++) {
        let item = ip_addresses[i];
        if (item.includes('-')) {
            // item contains '-'. Split on the '-'
            let split_str = item.split('-');
            if (split_str.length != 2) {
                console.log('IP address format incorrect. Should by x.x.x.x-y.y.y.y');
                process.exit(1);
            }
            let ip_start = split_str[0];
            let ip_end = split_str[1];

            let tmp_list = generate_range(ip_start, ip_end);

            // Copy
            for (let x = 0; x < tmp_list.length; x++) ip_list.push(tmp_list[x]);
        }
        else {
            // item does not include a '-' symbol
            ip_list.push(item);
        }
    }


    // console.log('Scanning ' + ip_list.length + ' addresses from ' + ip_list[0] + ' to ' + ip_list[ip_list.length-1]);


    // hide error messages
    console.error = function () { };

    // try each IP address and each Port
    ip_list.forEach(function (ip_entry) {

        // workaround the ONVIF Library API
        // Cam() with a username and password tries to connect (and genertes a callback error)
        // and then it tries to call some SOAP methods which fails (and it generates a callback error)
        let shown_error = false;

        console.log("Connecting to " + ip_entry + ':' + port);

        const c = new Cam({
            hostname: ip_entry,
            username: username,
            password: password,
            port: port,
            timeout: 5000
        }, function CamFunc(err) {
            if (err) {
                if (shown_error == false) {
                    console.log('------------------------------');
                    console.log("Cannot connect to " + ip_entry + ":" + port);
                    // cut the error at \n
                    if (err.message) console.log(err.message);
                    else console.log(err);
                    console.log('------------------------------');
                    shown_error = true;
                }
                return;
            }

            let cam_obj = this;

            let got_date;
            let got_info;
            let got_videosources = [];
            let got_profiles = [];
            let bestProfile = []; // The preferred Profile indexed by Video Source.
            let got_snapshots = []; // JPEG Imag URLs, indexed by Video Source
            let got_livestreams = []; // RTSP URLs, indexed by Video Source

            // Use Nimble to execute each ONVIF function in turn
            // This is used so we can wait on all ONVIF replies before
            // writing to the console
            flow.series([
                function (nimble_callback) {
                    cam_obj.getSystemDateAndTime(function (err, date) {
                        if (!err) got_date = date;
                        nimble_callback();
                    });
                },
                function (nimble_callback) {
                    cam_obj.getDeviceInformation(function (err, info) {
                        if (!err) got_info = info;
                        nimble_callback();
                    });
                },
                function (nimble_callback) {
                    try {
                        cam_obj.getVideoSources(function (err, videoSources) {
                            if (!err) {
                                got_videosources = videoSources;

                                for (let i = 0; i < got_videosources.length; i++) {
                                    // create empty placeholders
                                    bestProfile.push({});
                                    got_snapshots.push({videoSourceToken: null, uri: null});
                                    got_livestreams.push({tcp: null, udp: null, http: null, multicast: null});
                                }
                            }
                            nimble_callback();
                        });
                    } catch {
                        nimble_callback();
                    }
                },
                function (nimble_callback) {
                    try {
                        cam_obj.getProfiles(function (err, profiles) {
                            if (!err) got_profiles = profiles;
                            nimble_callback();
                        });
                    } catch {
                        nimble_callback();
                    }
                },
                function (nimble_callback) {
                    // Compare VideoSources with Profiles.
                    // Get the 'best' ONVIF Profile Token for each Video Source
                    for (let src_idx = 0; src_idx < got_videosources.length; src_idx++) {
                        const videoSource = got_videosources[src_idx];

                        // Get the 'best' profile for this videoSource token
                        // For most cameras we just find the first Profile which has the Video Source Token
                        // but Hanwha emit the JPEG Profile first, then H264, then H265. So we have to find the 'best' Profile ourselves.
                        // The Best one is the first H265, otherwise the first H264, otherwise the first MPEG4 otherwise the first JPEG stream
                        let firstH265 = got_profiles.findIndex(item => 
                            item.videoSourceConfiguration && item.videoEncoderConfiguration
                            && item.videoSourceConfiguration.sourceToken == videoSource.$.token
                            && item.videoEncoderConfiguration.encoding == "H265");
                        let firstH264 = got_profiles.findIndex(item => 
                            item.videoSourceConfiguration && item.videoEncoderConfiguration
                            && item.videoSourceConfiguration.sourceToken == videoSource.$.token
                            && item.videoEncoderConfiguration.encoding == "H264");
                        let firstMPEG4 = got_profiles.findIndex(item => 
                            item.videoSourceConfiguration && item.videoEncoderConfiguration
                            && item.videoSourceConfiguration.sourceToken == videoSource.$.token
                            && item.videoEncoderConfiguration.encoding == "MPEG4");
                        let firstJPEG = got_profiles.findIndex(item => 
                            item.videoSourceConfiguration && item.videoEncoderConfiguration
                            && item.videoSourceConfiguration.sourceToken == videoSource.$.token
                            && item.videoEncoderConfiguration.encoding == "JPEG");
                        let firstOther = got_profiles.findIndex(item => 
                            item.videoSourceConfiguration && item.videoEncoderConfiguration
                            && item.videoSourceConfiguration.sourceToken == videoSource.$.token
                            );

                        if (firstH265 >= 0) bestProfile[src_idx] = got_profiles[firstH265];
                        else if (firstH264 >= 0) bestProfile[src_idx] = got_profiles[firstH264];
                        else if (firstMPEG4 >= 0) bestProfile[src_idx] = got_profiles[firstMPEG4];
                        else if (firstJPEG >= 0) bestProfile[src_idx] = got_profiles[firstJPEG];
                        else bestProfile[src_idx] = got_profiles[firstOther];
                    }

                    nimble_callback();
                },
                function (nimble_callback) {
                    try {
                        // The ONVIF device may have multiple Video Sources
                        // eg 4 channel IP encoder or Panoramic Cameras
                        // Grab a JPEG Image from each VideoSource
                        // Note. The Nimble Callback is only called once all ONVIF replies have been returned
                        const reply_max = got_videosources.length;
                        let reply_count = 0;

                        for (let src_idx = 0; src_idx < got_videosources.length; src_idx++) {
                            const videoSource = got_videosources[src_idx];

                            cam_obj.getSnapshotUri({ profileToken: bestProfile[src_idx].$.token}, (err, getUri_result) => {
                                reply_count++;

                                if (!err && getUri_result) {

                                    got_snapshots[src_idx] = {videoSourceToken: videoSource.$.token, uri: getUri_result.uri};

                                    const fs = require('fs');
                                    const url = require('url');

                                    let filename = "";
                                    if (got_videosources.length === 1) {
                                        filename = folder + path.sep + 'snapshot_' + ip_entry + '.jpg';
                                    } else {
                                        // add _1, _2, _3 etc for cameras with multiple VideoSources
                                        filename = folder + path.sep + 'snapshot_' + ip_entry + '_' + (src_idx + 1) + '.jpg';
                                    }
                                    let uri = url.parse(getUri_result.uri);

                                    // handle the case where the camera is behind NAT
                                    // ONVIF Standard now says use XAddr for camera
                                    // and ignore the IP address in the Snapshot URI
                                    uri.host = ip_entry;
                                    uri.username = username;
                                    uri.password = password;
                                    if (!uri.port) uri.port = 80;

                                    let digestRequest = require('request-digest')(username, password);
                                    digestRequest.request({
                                        host: 'http://' + uri.host,
                                        path: uri.path,
                                        port: uri.port,
                                        encoding: null, // return data as a Buffer()
                                        method: 'GET'
                                        //                             headers: {
                                        //                               'Custom-Header': 'OneValue',
                                        //                               'Other-Custom-Header': 'OtherValue'
                                        //                             }
                                    }, function (error, response, body) {
                                        if (error) {
                                            // console.log('Error downloading snapshot');
                                            // throw error;
                                        } else {

                                            fs.open(filename, 'w', function (err) {
                                                // callback for file opened, or file open error
                                                if (err) {
                                                    console.log('ERROR - cannot create output log file');
                                                    console.log(err);
                                                    console.log('');
                                                    process.exit(1);
                                                }
                                                fs.appendFile(filename, body, function (err) {
                                                    if (err) {
                                                        console.log('Error writing to file');
                                                    }
                                                });

                                            });
                                        }
                                    });
                                }

                                if (reply_count === reply_max) nimble_callback(); // let 'flow' move on. JPEG GET is still async
                            });
                        } // end for
                    } catch (err) { nimble_callback(); }
                },
                function (nimble_callback) {
                    const reply_max = got_videosources.length * 4; // x4 for TCP, UDP, HTTP and MULTICAST URLs
                    let reply_count = 0;
                    for (let src_idx = 0; src_idx < got_videosources.length; src_idx++) {
                        const profileToken = bestProfile[src_idx].$.token;

                        flow.series([
                            function (inner_nimble_callback) {
                                try {
                                    cam_obj.getStreamUri({
                                        protocol: 'RTSP',
                                        stream: 'RTP-Unicast',
                                        profileToken: profileToken
                                    }, function (err, stream) {
                                        if (!err) got_livestreams[src_idx].tcp = stream.uri;
                                        reply_count++;
                                        inner_nimble_callback();
                                        if (reply_count == reply_max) nimble_callback();
                                    });
                                } catch (err) { 
                                    inner_nimble_callback();
                                    reply_count++;
                                    if (reply_count == reply_max) nimble_callback();
                                }
                            },
                            function (inner_nimble_callback) {
                                try {
                                    cam_obj.getStreamUri({
                                        protocol: 'UDP',
                                        stream: 'RTP-Unicast',
                                        profileToken: profileToken
                                    }, function (err, stream) {
                                        if (!err) got_livestreams[src_idx].udp = stream.uri;
                                        reply_count++;
                                        inner_nimble_callback();
                                        if (reply_count == reply_max) nimble_callback();
                                    });
                                } catch (err) {
                                    reply_count++;
                                    inner_nimble_callback();
                                    if (reply_count == reply_max) nimble_callback();
                                }
                            },
                            function (inner_nimble_callback) {
                                try {
                                    cam_obj.getStreamUri({
                                        protocol: 'HTTP',
                                        stream: 'RTP-Unicast',
                                        profileToken: profileToken
                                    }, function (err, stream) {
                                        if (!err) got_livestreams[src_idx].http = stream.uri;
                                        reply_count++;
                                        inner_nimble_callback();
                                        if (reply_count == reply_max) nimble_callback();
                                    });
                                } catch (err) {
                                    reply_count++;
                                    inner_nimble_callback();
                                    if (reply_count == reply_max) nimble_callback();
                                }
                            },
                            function (inner_nimble_callback) {
                                /* Multicast is optional in Profile S, Mandatory in Profile T but could be disabled */
                                try {
                                    cam_obj.getStreamUri({
                                        protocol: 'UDP',
                                        stream: 'RTP-Multicast',
                                        profileToken: profileToken
                                    }, function (err, stream, xml) {
                                        if (!err) got_livestreams[src_idx].multicast = stream.uri;
                                        reply_count++;
                                        inner_nimble_callback();
                                        if (reply_count == reply_max) nimble_callback();
                                    });
                                } catch (err) {
                                    reply_count++;
                                    inner_nimble_callback();
                                    if (reply_count == reply_max) nimble_callback();
                                }
                            }
                        ]); // end of inner flow
                    } // end for loop
                    
                    // Note nimble_callback(); is called when all work is done
                },
                function (nimble_callback) {
                    console.log('------------------------------');
                    console.log('Host: ' + ip_entry + ' Port: ' + port);
                    console.log('Date: = ' + got_date);
                    console.log('Info: = ' + JSON.stringify(got_info));
                    for (let i = 0; i < got_videosources.length; i++) {
                        let msg = "Video Source " + (i+1) + ' [' + got_videosources[i].$.token + '] [' + bestProfile[i].videoEncoderConfiguration.encoding + ' '
                        + bestProfile[i].videoEncoderConfiguration.resolution.width + 'x' + bestProfile[i].videoEncoderConfiguration.resolution.height + ']';

                        console.log(msg);

                        if (got_snapshots[i].uri != null) {
                            console.log('Snapshot URI: =          ' + got_snapshots[i].uri);
                        }
                        if (got_livestreams[i].tcp != null) {
                            console.log('Live TCP Stream: =       ' + got_livestreams[i].tcp);
                        }
                        if (got_livestreams[i].udp != null) {
                            console.log('Live UDP Stream: =       ' + got_livestreams[i].udp);
                        }
                        if (got_livestreams[i].http != null) {
                            console.log('Live HTTP Stream: =      ' + got_livestreams[i].http);
                        }
                        if (got_livestreams[i].multicast != null) {
                            console.log('Live Multicast Stream: = ' + got_livestreams[i].multicast);
                        }
                        console.log('------------------------------');
                    }

                    let log_filename = folder + path.sep + 'camera_report_' + ip_entry + '.txt';
                    let log_fd;

                    fs.open(log_filename, 'w', function (err, fd) {
                        if (err) {
                            console.log('ERROR - cannot create output file ' + log_filename);
                            console.log(err);
                            console.log('');
                            process.exit(1);
                        }
                        log_fd = fd;
                        //console.log('Log File Open (' + log_filename + ')');

                        // write to log file in the Open callback
                        let msg = 'Host:= ' + ip_entry + ' Port:= ' + port + '\r\n';
                        if (got_date) {
                            msg += 'Date:= ' + got_date + '\r\n';
                        } else {
                            msg += 'Date:= unknown\r\n';
                        }
                        if (got_info) {
                            msg += 'Manufacturer:= ' + got_info.manufacturer + '\r\n';
                            msg += 'Model:= ' + got_info.model + '\r\n';
                            msg += 'Firmware Version:= ' + got_info.firmwareVersion + '\r\n';
                            msg += 'Serial Number:= ' + got_info.serialNumber + '\r\n';
                            msg += 'Hardware ID:= ' + got_info.hardwareId + '\r\n';
                        } else {
                            msg += 'Manufacturer:= unknown\r\n';
                            msg += 'Model:= unknown\r\n';
                            msg += 'Firmware Version:= unknown\r\n';
                            msg += 'Serial Number:= unknown\r\n';
                            msg += 'Hardware ID:= unknown\r\n';
                        }
                        for (let i = 0; i < got_videosources.length; i++) {
                            msg += "Video Source " + (i+1) + ' [' + got_videosources[i].$.token + '] [' + bestProfile[i].videoEncoderConfiguration.encoding + ' '
                            + bestProfile[i].videoEncoderConfiguration.resolution.width + 'x' + bestProfile[i].videoEncoderConfiguration.resolution.height + ']\r\n';

                            if (got_snapshots[i].uri != null) {
                                msg += 'Snapshot URL: =          ' + got_snapshots[i].uri + '\r\n';
                            }

                            if (got_livestreams[i].tcp != null) {
                                msg += 'Live TCP Stream: =       ' + got_livestreams[i].tcp + '\r\n';
                            }
                            if (got_livestreams[i].udp != null) {
                                msg += 'Live UDP Stream: =       ' + got_livestreams[i].udp + '\r\n';
                            }
                            if (got_livestreams[i].http != null) {
                                msg += 'Live HTTP Stream: =      ' + got_livestreams[i].http + '\r\n';
                            }
                            if (got_livestreams[i].multicast != null) {
                                msg += 'Live Multicast Stream: = ' + got_livestreams[i].multicast + '\r\n';
                            }
                        }
                        fs.write(log_fd, msg, function (err) {
                            if (err)
                                console.log('Error writing to file');
                        });

                    });




                    nimble_callback();
                },

            ]); // end flow

        });

        // Log ONVIF XML Messages from the Onvif Library
        //c.on("rawRequest", (data) => console.log("\nTX DATA:", data));
        //c.on("rawResponse", (data) => console.log("\nRX DATA:", data));

    }); // foreach
}

function generate_range(start_ip, end_ip) {
    let start_long = toLong(start_ip);
    let end_long = toLong(end_ip);
    if (start_long > end_long) {
        let tmp = start_long;
        start_long = end_long
        end_long = tmp;
    }
    let range_array = [];
    for (let i = start_long; i <= end_long; i++) {
        range_array.push(fromLong(i));
    }
    return range_array;
}

//toLong taken from NPM package 'ip' 
function toLong(ip) {
    let ipl = 0;
    ip.split('.').forEach(function (octet) {
        ipl <<= 8;
        ipl += parseInt(octet);
    });
    return (ipl >>> 0);
}

//fromLong taken from NPM package 'ip' 
function fromLong(ipl) {
    return ((ipl >>> 24) + '.' +
        (ipl >> 16 & 255) + '.' +
        (ipl >> 8 & 255) + '.' +
        (ipl & 255));
}
