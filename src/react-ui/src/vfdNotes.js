// Front-panel setup notes for each supported VFD, ported from the classic Tool page.
export const VFD_NOTES = [
 {
  "kind": "eq",
  "key": "HUANYANG VFD",
  "rows": [
   [
    "PD000",
    "0",
    "Unlock",
    "Unlock parameters"
   ],
   [
    "PD001",
    "2",
    "RS485",
    "Command source"
   ],
   [
    "PD002",
    "2",
    "RS485",
    "Speed/frequency source"
   ],
   [
    "PD163",
    "1",
    "Modbus ID",
    "Must match #[tt bus-id] above."
   ],
   [
    "PD164",
    "1",
    "9600 baud",
    "Must match #[tt baud] above."
   ],
   [
    "PD165",
    "3",
    "8 bit, no parity, RTU mode",
    "Must match #[tt parity] above."
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/Huanyang-VFD-manual.pdf",
  "link": "Huanyang VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "NOWFOREVER VFD",
  "rows": [
   [
    "P0-000",
    "2",
    "Modbus communication",
    "Command source"
   ],
   [
    "P0-001",
    "0",
    "Main frequence X",
    "Select frequency source"
   ],
   [
    "P0-002",
    "6",
    "Modbus communication",
    "Main frequency X"
   ],
   [
    "P0-055",
    "1",
    "Modbus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "P0-056",
    "2",
    "9600 baud",
    "Must match #[tt baud] above"
   ],
   [
    "P0-057",
    "0",
    "1 start, 8 data, no parity, 1 stop",
    "Must match #[tt parity] above"
   ]
  ],
  "href": null,
  "link": null,
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "DELTA VFD015M21A",
  "rows": [
   [
    "Pr.00",
    "3",
    "RS-485",
    "Source of frequency command"
   ],
   [
    "Pr.01",
    "3",
    "RS-485 with STOP",
    "Source of operation command"
   ],
   [
    "Pr.88",
    "1",
    "Modbus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "Pr.89",
    "1",
    "9600 baud",
    "Must match #[tt baud] above"
   ],
   [
    "Pr.92",
    "3",
    "8 bit, no parity, RTU mode",
    "Must match #[tt parity] above"
   ],
   [
    "Pr.157",
    "1",
    "Modbus mode",
    "Communication mode"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/Delta_VFD015M21A.pdf",
  "link": "Delta VFD015M21A VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "YL600",
  "rows": [
   [
    "P00.01",
    "3",
    "Modbus RS-485",
    "Start / stop command source"
   ],
   [
    "P03.00",
    "3",
    "9600 baud",
    "Must match #[tt baud] above"
   ],
   [
    "P03.01",
    "1",
    "Modbus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "P03.02",
    "5",
    "8 bit, no parity, 2 stop",
    "Must match #[tt parity] above"
   ],
   [
    "P03.04",
    "500",
    "RS-485 max delay",
    "Time in milliseconds"
   ],
   [
    "P07.15",
    "5",
    "RS-485",
    "Frequency source"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/YL620-A.pdf",
  "link": "YL600 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "SUNFAR",
  "rows": [
   [
    "F0.0",
    "2",
    "Serial communication",
    "Frequency source"
   ],
   [
    "F0.2",
    "1002",
    "Serial communication",
    "Control source"
   ],
   [
    "F4.0",
    "0104",
    "Modbus, no parity, 9600 baud",
    "Must match #[tt parity] and #[tt baud] above"
   ],
   [
    "F4.1",
    "1",
    "Bus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "F4.4",
    "3",
    "Seconds",
    "Communication timeout"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/Sunfar-E300.pdf",
  "link": "Sunfar E300 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "OMRON",
  "rows": [
   [
    "C071",
    "5",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "C072",
    "1",
    "Bus ID 1",
    "Must match #[tt bus-id] above"
   ],
   [
    "C074",
    "0",
    "No parity",
    "Must match #[tt parity] above"
   ],
   [
    "C075",
    "2",
    "2 stop bits",
    "Serial stop bits"
   ],
   [
    "C076",
    "4",
    "Deceleration stop",
    "Communication error action"
   ],
   [
    "C077",
    "500",
    "0.5 seconds",
    "Communication error timeout"
   ],
   [
    "C078",
    "1",
    "1 milisecond",
    "Communication wait time"
   ],
   [
    "C096",
    "0",
    "Modbus-RTU",
    "Communication mode"
   ],
   [
    "P200",
    "0",
    "Standard",
    "Modbus mapping"
   ],
   [
    "P400",
    "0",
    "Big endian",
    "Communication byte order"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/omron_i570_mx2.pdf",
  "link": "OMRON MX2 VFD manual",
  "extra": "The VFD must be rebooted after changing  the above settings."
 },
 {
  "kind": "starts",
  "key": "V70",
  "rows": [
   [
    "F001",
    "2",
    "Communication port",
    "Control mode"
   ],
   [
    "P0.0.04",
    "9",
    "Modbus",
    "Frequency source A"
   ],
   [
    "P0.1.00",
    "0",
    "Source A",
    "Frequency source"
   ],
   [
    "P4.1.00",
    "3",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "F002",
    "2",
    "Communication port",
    "Frequency setting selection"
   ],
   [
    "F163",
    "1",
    "Slave address",
    "Must match #[tt bus-id] above"
   ],
   [
    "F164",
    "1",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "F165",
    "3",
    "8 data, no parity, 1 stop, RTU",
    "Must match #[tt parity] above"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/stepperonline-v70.pdf",
  "link": "V70 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "H100",
  "rows": [
   [
    "F001",
    "2",
    "Communication port",
    "Control mode"
   ],
   [
    "F002",
    "2",
    "Communication port",
    "Frequency setting selection"
   ],
   [
    "F163",
    "1",
    "Slave address",
    "Must match #[tt bus-id] above"
   ],
   [
    "F164",
    "1",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "F165",
    "3",
    "8 data, no parity, 1 stop, RTU",
    "Must match #[tt parity] above"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/h100.pdf",
  "link": "LS Electric H100 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "WJ200",
  "rows": [
   [
    "A001",
    "3",
    "Modbus",
    "Frequency source"
   ],
   [
    "A002",
    "3",
    "Modbus",
    "Run source"
   ],
   [
    "C071",
    "5",
    "9600 BAUD rate",
    "Must match #[tt baud] above"
   ],
   [
    "C072",
    "1",
    "Slave address",
    "Must match #[tt bus-id] above"
   ],
   [
    "C074",
    "0",
    "no parity",
    "Must match #[tt parity] above"
   ],
   [
    "C075",
    "2",
    "2 stop bits",
    "Communication stop bits"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/wj200.pdf",
  "link": "WJ200 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "DMM DYN4",
  "rows": [
   [
    "40001",
    "1",
    "Drive ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "40002",
    "0",
    "RS232, relative mode, enable",
    "Drive config"
   ],
   [
    "40035",
    "0",
    "8-bit data, 1 start, no parity, two stop",
    "Communication format"
   ],
   [
    "40036",
    "1",
    "9600 BAUD rate",
    "Must match #[tt baud] above"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/dmm_dyn4.pdf",
  "link": "DMM DYN4 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "GALT G200",
  "rows": [
   [
    "P00.01",
    "2",
    "MODBUS control",
    "Run command channel"
   ],
   [
    "P00.06",
    "8",
    "Frequency set by MODBUS",
    "Frequency command selection"
   ],
   [
    "P14.00",
    "1",
    "Drive ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "P14.01",
    "3",
    "9600 BAUD rate",
    "Must match #[tt baud] above"
   ],
   [
    "P14.02",
    "3",
    "No parity, 8 data bits, 2 stop bits, RTU mode",
    "Communication mode"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/galt_g200-vfd.pdf",
  "link": "Galt G200 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "TECO WEST",
  "rows": [
   [
    "09-00",
    "1",
    "Bus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "09-01",
    "0",
    "MODBUS",
    "Communication mode"
   ],
   [
    "09-02",
    "3",
    "9600 BAUD rate",
    "Must match #[tt baud] above"
   ],
   [
    "09-03",
    "1",
    "2 stop bits",
    "Stop bits"
   ],
   [
    "09-04",
    "0",
    "No parity",
    "Communication parity"
   ],
   [
    "09-05",
    "0",
    "8 data bits",
    "Communication bits"
   ],
   [
    "00-02",
    "2",
    "MODBUS control",
    "Main run command source"
   ],
   [
    "00-05",
    "5",
    "MODBUS control",
    "Main frequency command source"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/teco_e510-vfd.pdf",
  "link": "Teco Westinghouse E510 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "FULING DZB200",
  "rows": [
   [
    "F0.01",
    "2",
    "Modbus",
    "Command source"
   ],
   [
    "F0.03",
    "6",
    "Modbus",
    "Frequency source"
   ],
   [
    "F6.00",
    "1",
    "Modbus address",
    "Must match #[tt bus-id] above"
   ],
   [
    "F6.01",
    "3",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "F6.02",
    "3",
    "N82 RTU",
    "Data format"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/fuling_dzb200.pdf",
  "link": "Fuling DZB200/300 VFD manual",
  "extra": ""
 },
 {
  "kind": "starts",
  "key": "HUANYANG GT",
  "rows": [
   [
    "P0.01",
    "2",
    "Communication",
    "Run command source"
   ],
   [
    "P0.03",
    "400.00",
    "Maximum frequency",
    "Set to suit the spindle.  Reported speed depends on this."
   ],
   [
    "P0.04",
    "400.00",
    "Upper frequency limit",
    "Set equal to #[tt P0.03] or the VFD clamps below maximum"
   ],
   [
    "P0.05",
    "0.00",
    "Lower frequency limit",
    "Set to suit the spindle"
   ],
   [
    "P0.07",
    "7",
    "Remote communication",
    "Frequency A command source"
   ],
   [
    "PC.00",
    "1",
    "Local address",
    "Must match #[tt bus-id] above"
   ],
   [
    "PC.01",
    "3",
    "9600 BAUD",
    "Must match #[tt baud] above"
   ],
   [
    "PC.02",
    "0",
    "N81 RTU",
    "Data format"
   ],
   [
    "PC.06",
    "00",
    "Respond to writing",
    "Writes fail if the unit's digit is 1"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/Huanyang-GT-manual.pdf",
  "link": "Huanyang GT-series VFD manual",
  "extra": ""
 },
 {
  "kind": "eq",
  "key": "DELTA VFD (GENERIC)",
  "rows": [
   [
    "Pr.00",
    "3",
    "RS-485",
    "Source of frequency command"
   ],
   [
    "Pr.01",
    "3",
    "RS-485 with STOP",
    "Source of operation command"
   ],
   [
    "Pr.88",
    "1",
    "Modbus ID",
    "Must match #[tt bus-id] above"
   ],
   [
    "Pr.89",
    "1",
    "9600 baud",
    "Must match #[tt baud] above"
   ],
   [
    "Pr.92",
    "3",
    "8 bit, no parity, RTU mode",
    "Must match #[tt parity] above"
   ],
   [
    "Pr.157",
    "1",
    "Modbus mode",
    "Communication mode"
   ]
  ],
  "href": "https://buildbotics.com/upload/vfd/Delta_VFD015M21A.pdf",
  "link": "Delta VFD015M21A VFD manual",
  "extra": ""
 }
];
