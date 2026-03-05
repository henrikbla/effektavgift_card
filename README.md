Custom card config: 

```
type: custom:effektavgift-card
entity: sensor.slimmelezer_power_consumed
title: Effektavgift
price_per_kw: 81.25
```

Add the following to your configuration.yaml to enable automations to run:

```
shell_command:
  effektavgift_calc: "python3 /config/scripts/effektavgift_calc.py"
  effektavgift_backfill: "python3 /config/scripts/effektavgift_backfill.py"
```
