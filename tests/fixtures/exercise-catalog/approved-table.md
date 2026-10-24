# The approved sample table

Copied by hand from the report the owner approved (the 110 deadlift, bench press and squat entries), not
produced by the pipeline. The test reads this file and compares the pipeline's output with it.

Muscle codes: ch chest, fd front_delts, bi biceps, tri triceps, fa forearms, tp traps, la lats, ub upper_back,
lb lower_back, abs abs, gl glutes, qd quads, ham hamstrings, cv calves, add adductors, abd abductors.
`fd?` means a shoulder the name rule could not place. `*` marks an override or a fix in the report; the
test ignores it. A text in brackets after a cell is a note in the report and is ignored too.

## base=bench-press

| id | equipment | variations | primary | secondary |
|---|---|---|---|---|
| Barbell_Bench_Press_-_Medium_Grip | barbell | medium-grip | ch | fd,tri |
| Barbell_Guillotine_Bench_Press | barbell | guillotine | ch | fd,tri |
| Barbell_Incline_Bench_Press_-_Medium_Grip | barbell | incline,medium-grip | ch | fd,tri |
| Bench_Press_-_Powerlifting | barbell | powerlifting-style | tri | ch,fa,la,fd |
| Bench_Press_-_With_Bands | barbell* | bands | ch | fd,tri |
| Bench_Press_with_Chains | barbell | chains | tri | ch,la,fd |
| Close-Grip_Barbell_Bench_Press | barbell | close-grip | tri | ch,fd |
| Decline_Barbell_Bench_Press | barbell | decline | ch | fd,tri |
| Decline_Dumbbell_Bench_Press | dumbbell | decline | ch | fd,tri |
| Dumbbell_Bench_Press | dumbbell | - | ch | fd,tri |
| Dumbbell_Bench_Press_with_Neutral_Grip | dumbbell | neutral-grip | ch | fd,tri |
| Hammer_Grip_Incline_DB_Bench_Press | dumbbell | incline,neutral-grip | ch | fd,tri |
| Machine_Bench_Press | machine | - | ch | fd,tri |
| One_Arm_Dumbbell_Bench_Press | dumbbell | one-arm | ch | fd,tri |
| Reverse_Band_Bench_Press | barbell | reverse-bands* | tri | ch,fa,la,ub,fd |
| Reverse_Triceps_Bench_Press | barbell | reverse-grip | tri | ch,fd |
| Smith_Machine_Bench_Press | smith_machine* | - | ch | fd,tri |
| Smith_Machine_Close-Grip_Bench_Press | smith_machine* | close-grip | tri | ch,fd |
| Smith_Machine_Incline_Bench_Press | smith_machine* | incline | ch | fd,tri |
| Wide-Grip_Barbell_Bench_Press | barbell | wide-grip | ch | fd,tri |
| Wide-Grip_Decline_Barbell_Bench_Press | barbell | decline,wide-grip | ch | fd,tri |

## base=deadlift

| id | equipment | variations | primary | secondary |
|---|---|---|---|---|
| Axle_Deadlift | other* | axle* | lb | fa,gl,ham,ub,qd,tp |
| Barbell_Deadlift | barbell | - | lb | cv,fa,gl,ham,la,ub,qd,tp |
| Cable_Deadlifts | cable | - | qd | fa,gl,ham,lb |
| Car_Deadlift | other* | car* | qd | fa,gl,ham,lb,tp |
| Clean_Deadlift | barbell | clean-style | ham | fa,gl,lb,ub,qd,tp |
| Deadlift_with_Bands | barbell | bands | lb | fa,gl,ham,ub,qd,tp |
| Deadlift_with_Chains | barbell | chains | lb | fa,gl,ham,ub,qd,tp |
| Deficit_Deadlift | barbell | deficit | lb | fa,gl,ham,ub,qd,tp |
| Kettlebell_One-Legged_Deadlift | kettlebell | single-leg | ham | gl,lb |
| Leverage_Deadlift | machine | plate-loaded | qd | gl,ham |
| One-Arm_Side_Deadlift | barbell | one-arm | qd | abs,cv,gl,ham,lb,tp |
| Rack_Pull_with_Bands | barbell | rack,bands | lb | fa,gl,ham,qd,tp |
| Rack_Pulls | barbell | rack | lb | fa,gl,ham,tp |
| Reverse_Band_Deadlift | barbell | reverse-bands* | lb | abd,add,cv,gl,ham,qd |
| Reverse_Band_Sumo_Deadlift | barbell | sumo,reverse-bands* | ham | abd,add,cv,fa,gl,lb,qd,tp |
| Rickshaw_Deadlift | other* | rickshaw* | qd | fa,gl,ham,lb,tp |
| Romanian_Deadlift | barbell | romanian | ham | cv,gl,lb |
| Romanian_Deadlift_from_Deficit | barbell | romanian,deficit | ham | fa,gl,lb,tp |
| Smith_Machine_Stiff-Legged_Deadlift | smith_machine* | stiff-leg | ham | gl,lb |
| Snatch_Deadlift | barbell | snatch-style | ham | fa,gl,lb,qd,tp (ham removed*) |
| Stiff-Legged_Barbell_Deadlift | barbell | stiff-leg | ham | gl,lb |
| Stiff-Legged_Dumbbell_Deadlift | dumbbell | stiff-leg | ham | gl,lb |
| Sumo_Deadlift | barbell | sumo | ham | add,fa,gl,lb,ub,qd,tp |
| Sumo_Deadlift_with_Bands | barbell | sumo,bands | ham | add,fa,gl,lb,ub,qd,tp |
| Sumo_Deadlift_with_Chains | barbell | sumo,chains | ham | abd,add,fa,gl,lb,ub,qd,tp |
| Trap_Bar_Deadlift | trap_bar* | - | qd | gl,ham |

## base=good-morning

| id | equipment | variations | primary | secondary |
|---|---|---|---|---|
| Band_Good_Morning | resistance_band | - * | ham | gl,lb |
| Band_Good_Morning_Pull_Through | resistance_band | pull-through | ham | gl,lb |
| Good_Morning | barbell | - | ham | abs,gl,lb |
| Good_Morning_off_Pins | barbell | pins | ham | abs,gl,lb |
| Hanging_Bar_Good_Morning | barbell | hanging-bar | ham | abs,gl,lb |
| Seated_Good_Mornings | barbell | seated | lb | gl |
| Stiff_Leg_Barbell_Good_Morning | barbell | stiff-leg | lb | gl,ham |

## with a base column

| id | base | equipment | variations | primary | secondary |
|---|---|---|---|---|---|
| Barbell_Hack_Squat | hack-squat | barbell | - | qd | cv,fa,ham |
| Hack_Squat | hack-squat | machine | - | qd | cv,gl,ham |
| Narrow_Stance_Hack_Squats | hack-squat | machine | narrow-stance | qd | cv,gl,ham |
| Jerk_Dip_Squat | jerk-dip* | barbell | - | qd | abs,cv |
| Squat_Jerk | jerk | barbell | - | qd | cv,gl,ham,fd,tri |
| Freehand_Jump_Squat | jump-squat | bodyweight | - | qd | cv,gl,ham |
| Kneeling_Jump_Squat | jump-squat | barbell | kneeling | gl | cv,ham,qd |
| Weighted_Jump_Squat | jump-squat | barbell | weighted | qd | cv,gl,ham,lb |
| Kettlebell_Pistol_Squat | pistol-squat | kettlebell | - | qd | cv,gl,ham,fd? |
| Smith_Machine_Pistol_Squat | pistol-squat | smith_machine* | - | qd | cv,gl,ham |
| Weighted_Sissy_Squat | sissy-squat | barbell | weighted | qd | cv,gl,ham |
| Barbell_Side_Split_Squat | split-squat | barbell | - | qd | cv,ham,lb |
| Smith_Single-Leg_Split_Squat | split-squat | smith_machine* | single-leg | qd | cv,gl,ham |
| Split_Squat_with_Dumbbells | split-squat | dumbbell | - | qd | gl,ham |
| Split_Squats | split-squat | bodyweight | - | qd* | cv,gl,ham |
| Suspended_Split_Squat | split-squat | other | suspended | qd | abd,add,cv,gl,ham |
| Barbell_Full_Squat | squat | barbell | full | qd | cv,gl,ham,lb |
| Barbell_Squat | squat | barbell | - | qd | cv,gl,ham,lb |
| Barbell_Squat_To_A_Bench | squat | barbell | to-bench* | qd | cv,gl,ham,lb |
| Bodyweight_Squat | squat | bodyweight | - | qd | gl,ham |
| Box_Squat | squat | barbell | box | qd | add,cv,gl,ham,lb |
| Box_Squat_with_Bands | squat | barbell | bands,box | qd | abd,add,cv,gl,ham,lb |
| Box_Squat_with_Chains | squat | barbell | chains,box | qd | abd,add,cv,gl,ham,lb |
| Chair_Squat | squat | bodyweight* | - | qd | cv,gl,ham |
| Dumbbell_Squat | squat | dumbbell | - | qd | cv,gl,ham,lb |
| Dumbbell_Squat_To_A_Bench | squat | dumbbell | to-bench* | qd | cv,gl,ham,lb |
| Frankenstein_Squat | squat | barbell | frankenstein | qd | abs,cv,gl,ham |
| Front_Barbell_Squat | squat | barbell | front | qd | cv,gl,ham |
| Front_Barbell_Squat_To_A_Bench | squat | barbell | front,to-bench* | qd | cv,gl,ham |
| Front_Squat_Clean_Grip | squat | barbell | front,clean-grip* | qd | abs,gl,ham |
| Front_Squats_With_Two_Kettlebells | squat | kettlebell | front | qd | cv,gl |
| Goblet_Squat | squat | kettlebell | goblet | qd | cv,gl,ham,fd? |
| Jefferson_Squats | squat | barbell | jefferson | qd | cv,gl,ham,lb,tp |
| Kneeling_Squat | squat | barbell | kneeling | gl | abs,ham,lb |
| Lying_Machine_Squat | squat | machine | - | qd | cv,gl,ham |
| Narrow_Stance_Squats | squat | barbell | narrow-stance | qd | cv,gl,ham,lb |
| Olympic_Squat | squat | barbell | olympic | qd | cv,gl,ham |
| One_Leg_Barbell_Squat | squat | barbell | single-leg | qd | cv,gl,ham |
| One-Arm_Overhead_Kettlebell_Squats | squat | kettlebell | one-arm,overhead | qd | cv,gl,ham,fd |
| Overhead_Squat | squat | barbell | overhead | qd | abs,cv,gl,ham,lb,fd,tri |
| Plie_Dumbbell_Squat | squat | dumbbell | plie | qd | abs,cv,gl,ham |
| Reverse_Band_Box_Squat | squat | barbell | box,reverse-bands* | qd | abd,add,cv,fa,gl,ham,lb |
| Reverse_Band_Power_Squat | squat | barbell | reverse-bands* | qd | add,cv,gl,ham,lb |
| Single-Leg_High_Box_Squat | squat | other | single-leg,box | qd | gl,ham |
| Sit_Squats | squat | bodyweight | - | qd | abd,gl,ham |
| Smith_Machine_Squat | squat | smith_machine* | - | qd | cv,gl,ham,lb |
| Speed_Box_Squat | squat | barbell | box,speed | qd | cv,gl,ham |
| Speed_Squats | squat | barbell | speed | qd | cv,gl,ham,lb |
| Squat_with_Bands | squat | barbell | bands | qd | add,cv,gl,ham,lb |
| Squat_with_Chains | squat | barbell | chains | qd | add,cv,gl,ham,lb |
| Squat_with_Plate_Movers | squat | barbell | plate-movers | qd | abd,add,cv,gl,ham |
| Squats_-_With_Bands | squat | barbell* | bands | qd | cv,gl,ham,lb |
| Weighted_Squat | squat | other | weighted | qd | cv,gl,ham |
| Wide_Stance_Barbell_Squat | squat | barbell | wide-stance | qd | cv,gl,ham,lb |
| Zercher_Squats | squat | barbell | zercher | qd | cv,gl,ham |
| Kettlebell_Turkish_Get-Up_Squat_style | turkish-get-up | kettlebell | - | fd? | abs,cv,ham,qd,tri |
