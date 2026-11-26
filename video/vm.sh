#!/bin/bash
# vm.sh <cmd...>: run a command in ~/reckon-video on the testbench VM
gcloud compute ssh testbench --zone=us-central1-a --command="cd /home/USER/reckon-video && $*" 2>&1
