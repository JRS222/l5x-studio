# Module I/O & dataflow report — CONVEYOR_PLC

- modules: **11** (10 network, 0 hardware, 0 sub-devices, 1 controller)
- used image points: **20/90**; used discrete input bits: **0**; used output bits: **0**

| module | catalog | kind | protocol | address | RPI (µs) | used in/out bits | used points |
|---|---|---|---|---|---|---|---|
| Local | 1756-L83E | Controller | Controller | - | - | 0/0 in, 0/0 out | 0/0 |
| XFER01 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.107 | 10000 | 0/10 in, 0/10 out | 2/9 |
| XFER02 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.108 | 10000 | 0/10 in, 0/10 out | 2/9 |
| XFER03 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.109 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA01 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.100 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA02 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.101 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA03 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.102 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA04 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.103 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA05 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.104 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA06 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.105 | 10000 | 0/10 in, 0/10 out | 2/9 |
| ZPA07 | 1799ER-IQ10XOQ10/A | Network I/O | EtherNet/IP | 192.168.1.106 | 10000 | 0/10 in, 0/10 out | 2/9 |

## XFER01 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.107 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | XFER01:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER01:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER01:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER01:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER01:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER01:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER01:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER01:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER01:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER01:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | XFER01:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER01:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER01:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER01:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER01:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER01:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER01:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER01:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER01:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER01:O.Data.9 | word-mapped | image word used by Data |  |

## XFER02 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.108 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | XFER02:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER02:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER02:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER02:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER02:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER02:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER02:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER02:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER02:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER02:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | XFER02:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER02:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER02:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER02:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER02:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER02:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER02:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER02:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER02:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER02:O.Data.9 | word-mapped | image word used by Data |  |

## XFER03 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.109 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | XFER03:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER03:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER03:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER03:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER03:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER03:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER03:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER03:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER03:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER03:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | XFER03:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | XFER03:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | XFER03:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | XFER03:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | XFER03:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | XFER03:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | XFER03:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | XFER03:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | XFER03:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | XFER03:O.Data.9 | word-mapped | image word used by Data |  |

## ZPA01 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.100 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | ZPA01:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA01:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA01:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA01:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA01:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA01:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA01:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA01:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA01:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA01:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | ZPA01:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA01:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA01:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA01:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA01:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA01:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA01:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA01:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA01:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA01:O.Data.9 | word-mapped | image word used by Data |  |

## ZPA02 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.101 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | ZPA02:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA02:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA02:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA02:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA02:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA02:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA02:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA02:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA02:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA02:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | ZPA02:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA02:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA02:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA02:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA02:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA02:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA02:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA02:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA02:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA02:O.Data.9 | word-mapped | image word used by Data |  |

## ZPA03 — 1799ER-IQ10XOQ10/A (Network I/O)

- protocol: EtherNet/IP · IP 192.168.1.102 · RPI 10000 µs
- image: input 6 B, output 0 B; discrete capacity 10 in / 10 out (catalog)

| bit | address | status | how / tags | routines |
|---|---|---|---|---|
| 0 | ZPA03:I.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA03:I.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA03:I.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA03:I.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA03:I.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA03:I.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA03:I.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA03:I.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA03:I.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA03:I.Data.9 | word-mapped | image word used by Data |  |
| 0 | ZPA03:O.Data.0 | word-mapped | image word used by Data |  |
| 1 | ZPA03:O.Data.1 | word-mapped | image word used by Data |  |
| 2 | ZPA03:O.Data.2 | word-mapped | image word used by Data |  |
| 3 | ZPA03:O.Data.3 | word-mapped | image word used by Data |  |
| 4 | ZPA03:O.Data.4 | word-mapped | image word used by Data |  |
| 5 | ZPA03:O.Data.5 | word-mapped | image word used by Data |  |
| 6 | ZPA03:O.Data.6 | word-mapped | image word used by Data |  |
| 7 | ZPA03:O.Data.7 | word-mapped | image word used by Data |  |
| 8 | ZPA03:O.Data.8 | word-mapped | image word used by Data |  |
| 9 | ZPA03:O.Data.9 | word-mapped | image word used by Data |  |

## Notes
- Zone sensor words are copied bit-for-bit from ENET_INPUTS into NETS[1].ZPA[n].INPUTS (DEMO_CONVEYOR/ZPA_MAPPING); module input bits 0..7 therefore feed zone scan logic.
- Communication topology: 0 bridge segment(s); 10 EtherNet/IP device(s) directly on the controller.
- CAD models: Rockwell CAD files cannot be loaded offline; the schematic SVG provided is a terminal-level connection view of each module.
