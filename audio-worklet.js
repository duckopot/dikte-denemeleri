class Cap extends AudioWorkletProcessor{
  process(inputs){const c=inputs[0]&&inputs[0][0];if(c&&c.length)this.port.postMessage(c.slice(0));return true}
}
registerProcessor('cap',Cap);
