/******************************************************************************\

                 This file is part of the Buildbotics firmware.

                   Copyright (c) 2015 - 2018, Buildbotics LLC
                              All rights reserved.

      This file ("the software") is free software: you can redistribute it
      and/or modify it under the terms of the GNU General Public License,
       version 2 as published by the Free Software Foundation. You should
       have received a copy of the GNU General Public License, version 2
      along with the software. If not, see <http://www.gnu.org/licenses/>.

      The software is distributed in the hope that it will be useful, but
           WITHOUT ANY WARRANTY; without even the implied warranty of
       MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
                Lesser General Public License for more details.

        You should have received a copy of the GNU Lesser General Public
                 License along with the software.  If not, see
                        <http://www.gnu.org/licenses/>.

                 For information regarding this software email:
                   "Joseph Coffland" <joseph@buildbotics.com>

\******************************************************************************/

#include "io.h"

#include "status.h"
#include "util.h"
#include "command.h"
#include "exec.h"
#include "rtc.h"
#include "analog.h"
#include "switch.h"
#include "config.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>


typedef struct {
  int8_t port;
  bool digital;
  input_mode_t mode;
  float timeout;
} input_cmd_t;


static input_cmd_t active_cmd = {-1,};
static uint32_t timeout;
static int8_t last_level; // 1.45.0: last level seen while waiting for an edge


// User digital inputs (1.45.0).  Each is one of the eight motor limit pins,
// numbered 1-8 in switch table order: motor 0 min, motor 0 max, motor 1 min
// ... motor 3 max.  0 means not assigned.
static struct {
  uint8_t pin;
  uint8_t mode; // switch_type_t
} inputs[INPUTS];


static switch_id_t _input_switch(int port) {
  if (port < 0 || INPUTS <= port || !inputs[port].pin) return SW_INVALID;
  return (switch_id_t)(SW_MIN_0 + inputs[port].pin - 1);
}


/// -1 if the input is not assigned or not read yet, else 0 or 1
static int8_t _input_level(int port) {
  switch_id_t sw = _input_switch(port);
  if (sw == SW_INVALID || !switch_is_user(sw) || !switch_is_enabled(sw))
    return -1;
  if (!switch_is_ready(sw)) return -1; // Not debounced yet
  return switch_is_active(sw) ? 1 : 0;
}


static void _apply_input(int port) {
  // Release whatever the input had, then claim the new pin
  for (int sw = SW_MIN_0; sw <= SW_MAX_3; sw++) {
    bool used = false;
    for (int i = 0; i < INPUTS; i++)
      if (inputs[i].pin && _input_switch(i) == sw && inputs[i].mode) used = true;
    if (!used) switch_release_user((switch_id_t)sw);
  }

  switch_id_t sw = _input_switch(port);
  if (sw == SW_INVALID || !inputs[port].mode) return;
  if (!switch_set_user(sw, (switch_type_t)inputs[port].mode)) {
    // The pin is a limit switch: leave it alone and drop the assignment
    inputs[port].pin = 0;
  }
}


static void _send_result(float result) {
  printf_P(PSTR("{\"result\": %f}\n"), (double)result);
  active_cmd.port = -1;
}


void io_callback() {
  if (active_cmd.port == -1) return;

  if (!active_cmd.digital) {
    // Analog: read once the timeout is up (or now when immediate)
    if (active_cmd.mode == INPUT_IMMEDIATE || rtc_expired(timeout))
      _send_result(analog_get(active_cmd.port));
    return;
  }

  // Digital (1.45.0).  Result as LinuxCNC's #5399: the level when it is
  // read, or -1 when the input is not assigned or the wait timed out.
  int8_t level = _input_level(active_cmd.port);
  bool done = false;

  switch (active_cmd.mode) {
  case INPUT_IMMEDIATE: _send_result(level); return;
  case INPUT_HIGH: done = level == 1; break;
  case INPUT_LOW:  done = level == 0; break;

  case INPUT_RISE: case INPUT_FALL:
    if (last_level != -1 && level != -1 && level != last_level &&
        level == (active_cmd.mode == INPUT_RISE ? 1 : 0)) done = true;
    if (level != -1) last_level = level;
    break;
  }

  if (done) _send_result(level);
  else if (level == -1 && _input_switch(active_cmd.port) == SW_INVALID)
    _send_result(-1); // Not assigned: don't wait for nothing
  else if (rtc_expired(timeout)) _send_result(-1);
}


void io_stop() {active_cmd.port = -1;} // Stop or E-stop drops a wait


static stat_t _exec_cb() {
  if (active_cmd.port == -1) exec_set_cb(0);
  return STAT_NOP;
}


// Command callbacks
stat_t command_input(char *cmd) {
  input_cmd_t input_cmd;
  cmd++; // Skip command

  // Analog or digital
  if (*cmd == 'd') input_cmd.digital = true;
  else if (*cmd == 'a') input_cmd.digital = false;
  else return STAT_INVALID_ARGUMENTS;
  cmd++;

  // Port index
  if (!isdigit(*cmd)) return STAT_INVALID_ARGUMENTS;
  input_cmd.port = *cmd - '0';
  cmd++;

  // Mode
  if (!isdigit(*cmd)) return STAT_INVALID_ARGUMENTS;
  input_cmd.mode = (input_mode_t)(*cmd - '0');
  if (INPUT_LOW < input_cmd.mode) return STAT_INVALID_ARGUMENTS;
  cmd++;

  // Timeout
  if (!decode_float(&cmd, &input_cmd.timeout)) return STAT_BAD_FLOAT;

  command_push(COMMAND_input, &input_cmd);

  return STAT_OK;
}


unsigned command_input_size() {return sizeof(input_cmd_t);}


void command_input_exec(void *data) {
  active_cmd = *(input_cmd_t *)data;
  last_level = -1;

  timeout = rtc_get_time() + active_cmd.timeout * 1000;
  exec_set_cb(_exec_cb);
}


// Var callbacks (1.45.0)
uint8_t get_input_pin(int port) {return inputs[port].pin;}


void set_input_pin(int port, uint8_t pin) {
  if (8 < pin) pin = 0;
  if (inputs[port].pin == pin) return;
  inputs[port].pin = pin;
  _apply_input(port);
}


uint8_t get_input_mode(int port) {return inputs[port].mode;}


void set_input_mode(int port, uint8_t mode) {
  if (SW_NORMALLY_CLOSED < mode) mode = SW_DISABLED;
  if (inputs[port].mode == mode) return;
  inputs[port].mode = mode;
  _apply_input(port);
}


uint8_t get_input_state(int port) {
  int8_t level = _input_level(port);
  return level == -1 ? 2 : level;
}
