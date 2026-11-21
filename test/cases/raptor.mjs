// Golden cases for the schedule router (window.Raptor). No deps: raptor.js is
// plain-value math, so it loads clean in the vm sandbox. Every EXPECTED comment
// was worked out by hand from the network below. Notation: stop time, then the
// round it was reached in (r0 = walk only, rN = after N rides), "--" = unreached.

const T = (h, m) => h * 3600 + m * 60; // clock time to seconds after midnight

// Stops: 0 = A, 1 = B, 2 = C, 3 = D, 4 = E, 5 = F. E has no service: no trip boards there.
const STOPS = ["A", "B", "C", "D", "E", "F"].map((id) => ({ id, lat: 0, lon: 0 }));
const NETWORK = {
  stops: STOPS,
  trips: [
    { id: "T1", stops: [0, 1, 2], arr: [T(8, 0), T(8, 5), T(8, 10)], dep: [T(8, 0), T(8, 5), T(8, 10)] },
    { id: "T2", stops: [2, 3], arr: [T(8, 12), T(8, 20)], dep: [T(8, 12), T(8, 20)] },
    { id: "T3", stops: [1, 4], arr: [T(8, 20), T(8, 30)], dep: [T(8, 20), T(8, 30)] },
    { id: "T4", stops: [0, 1, 2], arr: [T(8, 30), T(8, 35), T(8, 40)], dep: [T(8, 30), T(8, 35), T(8, 40)] },
  ],
};
const EMPTY_NETWORK = { stops: [], trips: [] };

// Walk transfers indexed by stop: only C has one (C to F, 120 s).
const TRANSFERS = [];
TRANSFERS[2] = [{ to: 5, sec: 120 }];

// Same table with a walk out of A to F (100 s) and F to E (100 s). Used to show
// that a walk does not start from another walk.
const CHAIN_TRANSFERS = [];
CHAIN_TRANSFERS[0] = [{ to: 5, sec: 100 }];
CHAIN_TRANSFERS[2] = [{ to: 5, sec: 120 }];
CHAIN_TRANSFERS[5] = [{ to: 4, sec: 100 }];

const FROM_A = [{ stop: 0, sec: 60 }];

const route = (id, network, access, transfers, depart, opts) => ({
  id,
  call: "Raptor.evaluate",
  args: [network, "route", [access, transfers, depart, opts]],
});
const profile = (id, network, access, transfers, from, to, step, opts) => ({
  id,
  call: "Raptor.evaluate",
  args: [network, "profile", [access, transfers, from, to, step, opts]],
});

export default {
  scripts: ["js/core/raptor.js"],
  cases: [
    // EXPECTED: direct ride. Walk 60 s to A (07:59), T1 A to C: C 08:10 r1.
    // Full: A 07:59 r0, B 08:05 r1, C 08:10 r1, D 08:20 r2, E 08:30 r2, F 08:12 r1.
    route("direct-ride", NETWORK, FROM_A, TRANSFERS, T(7, 58), {}),

    // EXPECTED: origin is B at 08:00 (walk 0). Ride T1 B to C (08:10, r1), transfer
    // at C onto T2 (08:12) to D 08:20 r2. T3 B to E 08:30 r1. F 08:12 r1 via the
    // C walk. A is never reached (nothing leads back to it).
    route("one-transfer-at-C-onto-T2", NETWORK, [{ stop: 1, sec: 0 }], TRANSFERS, T(8, 0), {}),

    // EXPECTED: minTransferSec 180. C reached 08:10, T2 leaves C 08:12, so the
    // connection needs 08:13 and fails: D is unreached in every round. T4 reaches
    // C only at 08:40 and never goes to D, so no later trip rescues it.
    // E 08:30 r2 still works: T3 leaves B 08:20, B was reached 08:05 and 08:05 + 180 s is before 08:20.
    // F 08:12 r1.
    route("missed-connection-minT-180", NETWORK, FROM_A, TRANSFERS, T(7, 58), { minTransferSec: 180 }),

    // EXPECTED: walk transfer C to F after the 08:10 ride: F 08:12 r1 (120 s).
    // Same run as direct-ride; this case checks F.
    route("walk-transfer-C-to-F", NETWORK, FROM_A, TRANSFERS, T(7, 58), {}),

    // EXPECTED: maxRounds 1 (one ride only). D needs a second ride, so it is unreached.
    // F still 08:12 r1, because transfers after round 1 are applied in round 1.
    route("maxRounds-1-D-unreached", NETWORK, FROM_A, TRANSFERS, T(7, 58), { maxRounds: 1 }),

    // EXPECTED: maxSec 600, so the window ends at 08:08. T1 B at 08:05 is inside;
    // C at 08:10 is past the window, so C, D, E and F are all unreached.
    route("maxSec-600", NETWORK, FROM_A, TRANSFERS, T(7, 58), { maxSec: 600 }),

    // EXPECTED: two access stops. A walk 60 s (07:59). B walk 400 s (08:04:40), which
    // is earlier than riding T1 to B (08:05), so B is r0. E 08:30 r1 comes from T3
    // boarded at B with the walk label. C 08:10 r1, D 08:20 r2, F 08:12 r1.
    route("two-access-later-walk-faster", NETWORK, [{ stop: 0, sec: 60 }, { stop: 1, sec: 400 }], TRANSFERS, T(7, 58), {}),

    // EXPECTED: profile 07:50 to 08:40 (toSec exclusive, so 08:40 is not a departure),
    // every 10 min: 07:50, 08:00, 08:10, 08:20, 08:30 (n = 5).
    // C travel times 1200, 2400, 1800, 1200, unreached: best 1200, typical 1800 (sorted[2]), worst Infinity.
    // D travel times 1800, unreached x4: best 1800, typical Infinity, worst Infinity.
    // A is 60 s throughout. B: 900, 2100, 1500, 900, unreached. E: 2400, unreached x4.
    // F: 1320, 2520, 1920, 1320, unreached. Only 07:50 reaches anything through D or E.
    profile("profile-card-window", NETWORK, FROM_A, TRANSFERS, T(7, 50), T(8, 40), 600, {}),

    // EXPECTED: profile 07:50 to 08:30, every 10 min: 07:50, 08:00, 08:10, 08:20 (n = 4, even).
    // C: 1200, 2400, 1800, 1200 sorted 1200, 1200, 1800, 2400. Lower median is sorted[1] = 1200,
    // not 1800. Worst is sorted[3] = 2400.
    // B: 900, 2100, 1500, 900: best 900, typical 900, worst 2100.
    // D: 1800, unreached x3: best 1800, typical Infinity, worst Infinity.
    // F: 1320, 2520, 1920, 1320: best 1320, typical 1320, worst 2520.
    // E: 2400, unreached x3: best 2400, typical Infinity, worst Infinity.
    profile("profile-even-count-lower-median", NETWORK, FROM_A, TRANSFERS, T(7, 50), T(8, 30), 600, {}),

    // EXPECTED: default stepSec 120 with window 07:50 to 07:55: departures 07:50, 07:52, 07:54 (n = 3).
    // Each departure gets the same route shape. A is 60 s. B: 900, 780, 660, so best 660,
    // typical 780, worst 900. C: 1200, 1080, 960, so best 960, typical 1080, worst 1200.
    // D: 1800, 1680, 1560, so best 1560, typical 1680, worst 1800.
    // E: 2400, 2280, 2160, so best 2160, typical 2280, worst 2400.
    // F: 1320, 1200, 1080, so best 1080, typical 1200, worst 1320.
    profile("profile-default-step", NETWORK, FROM_A, TRANSFERS, T(7, 50), T(7, 55), undefined, {}),

    // EXPECTED: empty network and empty access. Five departures (07:50 to 07:58; 08:00 is excluded),
    // and no per-stop values.
    profile("profile-empty-network", EMPTY_NETWORK, [], [], T(7, 50), T(8, 0), undefined, {}),

    // EXPECTED: empty network and empty access: arrival [] and rounds [].
    route("route-empty-network", EMPTY_NETWORK, [], [], T(7, 58), {}),

    // EXPECTED: no transfer walk follows the access walk, and a walk never starts from another walk.
    // A is reached by the access walk, so the A to F walk is not taken; F's first walk is C to F after
    // the 08:10 ride (120 s): F 08:12 r1. E is 08:30 r2 via T3 from B.
    // Full: A 07:59 r0, B 08:05 r1, C 08:10 r1, D 08:20 r2, E 08:30 r2, F 08:12 r1.
    route("no-chain-walk-after-walk", NETWORK, FROM_A, CHAIN_TRANSFERS, T(7, 58), {}),

    // EXPECTED: two origin walks to A (300 s, then 60 s). The minimum is 60 s: A 07:59.
    // With the first listed walk (300 s, A at 08:03) T1 would be missed and B would be unreached.
    // Full (maxRounds 1): A 07:59 r0, B 08:05 r1, C 08:10 r1, D --, E --, F 08:12 r1.
    route("access-duplicate-min", NETWORK, [{ stop: 0, sec: 300 }, { stop: 0, sec: 60 }], TRANSFERS, T(7, 58), { maxRounds: 1 }),
  ],
};
