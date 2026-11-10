// quality_report.mjs — ЗЕРКАЛО data/backtest-report.json для экрана «Качество прогноза» (FP-11). СГЕНЕРИРОВАНО tools/backtest_report.mjs, руками не править.
// Числа получены на СИНТЕТИЧЕСКИХ журналах (data/synthetic-journals), это не данные пользователей. Страница JSON не читает: сеть разрешена только приложению.
export const SYNTH_REPORT = {
 "format": "runway-backtest-report/1",
 "synthetic": true,
 "date": "2026-10-09",
 "engine_version": "0.1.0",
 "n_journals": 22,
 "params": {
  "backtest.h_days": 30,
  "backtest.min_window_days": 14,
  "calib.min_origins": 3,
  "wave.gap_days": 3,
  "wave.max_span_days": 10
 },
 "backtest": {
  "t0": "2026-03-01",
  "h": 14
 },
 "corpora": {
  "regular": {
   "n_journals": 12,
   "frr": {
    "k": 1,
    "n": 117,
    "bp": 85
   },
   "cry_wolf": {
    "k": 7,
    "n": 18,
    "bp": 3889
   },
   "gate": {
    "pass": true,
    "reasons": [],
    "n_journals": 12,
    "k1": 1,
    "n1": 117,
    "k2": 7,
    "n2": 18,
    "frr_bp": 85,
    "cry_wolf_bp": 3889
   },
   "journals": [
    {
     "id": "reg01",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 11,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg02",
     "n_origins": 15,
     "frr": {
      "k": 0,
      "n": 5,
      "bp": 0
     },
     "cry_wolf": {
      "k": 1,
      "n": 4,
      "bp": 2500
     }
    },
    {
     "id": "reg03",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 11,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg04",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 12,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg05",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 10,
      "bp": 0
     },
     "cry_wolf": {
      "k": 2,
      "n": 2,
      "bp": 10000
     }
    },
    {
     "id": "reg06",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 12,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg07",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 12,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg08",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 1,
      "bp": 10000
     },
     "cry_wolf": {
      "k": 0,
      "n": 8,
      "bp": 0
     }
    },
    {
     "id": "reg09",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 12,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg10",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 8,
      "bp": 0
     },
     "cry_wolf": {
      "k": 4,
      "n": 4,
      "bp": 10000
     }
    },
    {
     "id": "reg11",
     "n_origins": 15,
     "frr": {
      "k": 0,
      "n": 12,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    },
    {
     "id": "reg12",
     "n_origins": 15,
     "frr": {
      "k": 0,
      "n": 11,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 0,
      "bp": null
     }
    }
   ]
  },
  "stress": {
   "n_journals": 10,
   "frr": {
    "k": 7,
    "n": 32,
    "bp": 2188
   },
   "cry_wolf": {
    "k": 3,
    "n": 72,
    "bp": 417
   },
   "gate": {
    "pass": false,
    "reasons": [
     "frr_above_5pct"
    ],
    "n_journals": 10,
    "k1": 7,
    "n1": 32,
    "k2": 3,
    "n2": 72,
    "frr_bp": 2188,
    "cry_wolf_bp": 417
   },
   "journals": [
    {
     "id": "str01",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 0,
      "bp": null
     },
     "cry_wolf": {
      "k": 0,
      "n": 11,
      "bp": 0
     }
    },
    {
     "id": "str02",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 1,
      "bp": 0
     },
     "cry_wolf": {
      "k": 0,
      "n": 11,
      "bp": 0
     }
    },
    {
     "id": "str03",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 5,
      "bp": 2000
     },
     "cry_wolf": {
      "k": 2,
      "n": 7,
      "bp": 2857
     }
    },
    {
     "id": "str04",
     "n_origins": 14,
     "frr": {
      "k": 2,
      "n": 7,
      "bp": 2857
     },
     "cry_wolf": {
      "k": 0,
      "n": 3,
      "bp": 0
     }
    },
    {
     "id": "str05",
     "n_origins": 15,
     "frr": {
      "k": 0,
      "n": 0,
      "bp": null
     },
     "cry_wolf": {
      "k": 0,
      "n": 12,
      "bp": 0
     }
    },
    {
     "id": "str06",
     "n_origins": 14,
     "frr": {
      "k": 0,
      "n": 0,
      "bp": null
     },
     "cry_wolf": {
      "k": 1,
      "n": 11,
      "bp": 909
     }
    },
    {
     "id": "str07",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 8,
      "bp": 1250
     },
     "cry_wolf": {
      "k": 0,
      "n": 1,
      "bp": 0
     }
    },
    {
     "id": "str08",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 2,
      "bp": 5000
     },
     "cry_wolf": {
      "k": 0,
      "n": 2,
      "bp": 0
     }
    },
    {
     "id": "str09",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 2,
      "bp": 5000
     },
     "cry_wolf": {
      "k": 0,
      "n": 10,
      "bp": 0
     }
    },
    {
     "id": "str10",
     "n_origins": 14,
     "frr": {
      "k": 1,
      "n": 7,
      "bp": 1429
     },
     "cry_wolf": {
      "k": 0,
      "n": 4,
      "bp": 0
     }
    }
   ]
  }
 },
 "waves": {
  "origin": "2026-06-01",
  "horizon_days": 120,
  "deltas": {
   "gap_days": 1,
   "max_span_days": 3
  },
  "corpora": {
   "regular": {
    "n_journals": 12,
    "waves": 96,
    "single": 48,
    "single_share_bp": 5000,
    "changed": {
     "gap_days-1": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "gap_days+1": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "max_span_days-3": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "max_span_days+3": {
      "changed_waves": 0,
      "changed_share_bp": 0
     }
    }
   },
   "stress": {
    "n_journals": 10,
    "waves": 80,
    "single": 40,
    "single_share_bp": 5000,
    "changed": {
     "gap_days-1": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "gap_days+1": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "max_span_days-3": {
      "changed_waves": 0,
      "changed_share_bp": 0
     },
     "max_span_days+3": {
      "changed_waves": 0,
      "changed_share_bp": 0
     }
    }
   }
  }
 }
};
