(Bed camera markers: three 20 mm crosses carved with a 60 degree V-bit)
(Centres at machine X30 Y30, X380 Y30 and X30 Y380: front left, front right, back left)
(Before running: set work Z0 on the MDF next to the front-left cross)
(Depth 1.2 mm = lines about 1.4 mm wide)
G21 G90 G17 G94
G53 G0 Z-1

(First a check pass with the router off: it stops 5 mm above each cross)
(MSG, Check: the bit is over MDF, not a T-track. Press Play to go on)
G53 G0 X30 Y30
G90 G0 Z5
M0
G53 G0 Z-1
(MSG, Check: the bit is over MDF, not a T-track. Press Play to go on)
G53 G0 X380 Y30
G90 G0 Z5
M0
G53 G0 Z-1
(MSG, Check: the bit is over MDF, not a T-track. Press Play to start carving)
G53 G0 X30 Y380
G90 G0 Z5
M0
G53 G0 Z-1

(Carve)
M3 S18000
G4 P3

(Cross: front left, centre X30 Y30)
G53 G0 X20 Y30
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 X20 F1000
G90 G0 Z3
G53 G0 X30 Y20
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 Y20 F1000
G90 G0 Z3

(Cross: front right, centre X380 Y30)
G53 G0 X370 Y30
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 X20 F1000
G90 G0 Z3
G53 G0 X380 Y20
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 Y20 F1000
G90 G0 Z3

(Cross: back left, centre X30 Y380)
G53 G0 X20 Y380
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 X20 F1000
G90 G0 Z3
G53 G0 X30 Y370
G90 G0 Z3
G91 G1 Z-4.2 F300
G1 Y20 F1000
G90 G0 Z3

G53 G0 Z-1
M5
M2
