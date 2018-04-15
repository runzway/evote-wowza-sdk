/* @flow */
import logger from './logger'

const RTCPeerConnection = window.RTCPeerConnection
const RTCIceCandidate = window.RTCIceCandidate
const RTCSessionDescription = window.RTCSessionDescription

export default class Publisher {
  constructor(
    endpoint: string,
    applicationName: string,
    streamName: string,
    sessionId: string,
    options: {
      video: { bitRate: number, frameRate: string, codec: string },
      audio: { bitRate: number, codec: string },
      peerConnection: { iceServers: Array<any>, iceTransportPolicy: string },
      userData: object
    }
  ) {
    this.stream = null
    this.ws = null
    this.pc = null
    this.endpoint = endpoint
    this.streamInfo = {
      applicationName: applicationName,
      streamName: streamName,
      sessionId: sessionId
    }
    this.userData = {
      sessionId: sessionId
    }
    this.videoConfig = {
      bitRate: 360,
      frameRate: 64,
      codec: '42e01f',
      index: -1
    }
    this.audioConfig = {
      bitRate: 64,
      codec: 'opus',
      index: -1
    }
    this.peerConnectionConfig = {
      iceServers: []
    }
    this.SDPOutput = new Object()
    if (options) {
      if (options.userData) {
        this.userData = { ...this.userData, ...options.userData }
      }
      if (options.video) {
        this.videoConfig = { ...this.videoConfig, ...options.video }
      }
      if (options.audio) {
        this.audioConfig = { ...this.audioConfig, ...options.audio }
      }
      if (options.peerConnection) {
        this.peerConnectionConfig = {
          ...this.peerConnectionConfig,
          ...options.peerConnection
        }
      }
    }
  }

  connect(stream: MediaStream.prototype) {
    logger.write('PUBLISHER CONNECT', this.endpoint)
    return this.disconnect()
      .then(() => {
        this.pc = new RTCPeerConnection(this.peerConnectionConfig)
        this.pc.onicecandidate = event => {
          logger.write('PUBLISHER ON ICE CANDIDATE', event)
        }
        if (typeof this.pc.addStream === 'undefined') {
          stream.getTracks().forEach(track => {
            this.pc.addTrack(track, stream)
          })
        } else {
          this.pc.addStream(stream)
        }
        return Promise.resolve()
      })
      .then(this.createOffer.bind(this))
      .then(this.setLocalDescription.bind(this))
      .then(this.connectWebSocket.bind(this))
      .then(e => {
        logger.write('FINISH', e)
        return stream
      })
  }

  disconnect() {
    logger.write('PUBLISHER DISCONNECT', '')
    const closeStream = new Promise((resolve, _) => {
      if (this.stream) {
        this.stream.getTracks().forEach(track => {
          track.stop()
        })
      }
      this.stream = null
      return resolve()
    })
    const closePeerConnection = new Promise((resolve, reject) => {
      if (this.pc) {
        this.pc.close()
      }
      this.pc = null
      return resolve()
    })
    const closeWebSocket = new Promise((resolve, _) => {
      if (this.ws) {
        this.ws.close()
      }
      this.ws = null
      return resolve()
    })
    return Promise.all([closeStream, closePeerConnection, closeWebSocket])
  }

  createOffer() {
    return this.pc.createOffer().then(offer => {
      logger.write('PUBLISHER OFFER', offer)
      offer.sdp = this.createSignalingMessage(offer.sdp)
      logger.write('PUBLISHER ENHANCE OFFER', offer)
      return offer
    })
  }

  connectWebSocket(offer: object) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint)
      this.ws.binaryType = 'arraybuffer'
      this.ws.onopen = () => {
        logger.write('WEBSOCKET ON OPEN', offer)
        this.sendPublishMessage(offer)
      }
      this.ws.onmessage = async event => {
        logger.write('WEBSOCKET ON MESSAGE', event)
        const data = JSON.parse(event.data)
        const status = Number(data.status)
        if (status !== 200) {
          await this.disconnect()
          return reject(data)
        } else {
          if (data.sdp !== undefined) {
            this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          }
          if (data.iceCandidates !== undefined) {
            data.iceCandidates.forEach(iceCandidate => {
              this.pc.addIceCandidate(new RTCIceCandidate(iceCandidate))
            })
          }
        }
        if (this.ws !== null) {
          this.ws.close()
          this.ws = null
        }
        resolve()
      }
      this.ws.onclose = () => {
        logger.write('WEBSOCKET ON CLOSE', '')
      }
      this.ws.onerror = async event => {
        logger.write('WEBSOCKET ON ERROR', event)
        await this.disconnect()
        reject(event)
      }
    })
  }

  sendPublishMessage(offer: object) {
    this.ws.send(
      JSON.stringify({
        direction: 'publish',
        command: 'sendOffer',
        streamInfo: this.streamInfo,
        sdp: offer,
        userData: this.userData
      })
    )
  }

  setLocalDescription(offer: object) {
    return this.pc.setLocalDescription(offer).then(() => offer)
  }

  setRemoteDescription(data: object) {
    return this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
  }

  addIceCandidates(data: object) {
    logger.write('PUBLISHER ADD ICE CANDIDATES', data)
    if (data.iceCandidates !== undefined) {
      data.iceCandidates.forEach(iceCandidate => {
        this.pc.addIceCandidates(new RTCIceCandidate(iceCandidate))
      })
    }
  }

  createSignalingMessage(sdp) {
    let lines = sdp.split(/\r\n/)
    let section = 'header'
    let hitMID = false
    if (
      !sdp.includes('THIS_IS_SDPARTA') ||
      this.videoConfig.codec.includes('VP9')
    ) {
      lines = lines.filter(line => {
        if (line.length === 0) {
          return false
        }
        if (!this.checkLine(line)) {
          return false
        }
        return true
      })
      lines = this.addAudio(
        lines,
        this.deliverCheckLine(this.audioConfig.codec, 'audio')
      )
      lines = this.addVideo(
        lines,
        this.deliverCheckLine(this.videoConfig.codec, 'video')
      )
    }
    let result = []
    lines.forEach(line => {
      if (line.length === 0) {
        return
      }
      if (line.indexOf('m=audio') == 0 && this.audioConfig.index !== -1) {
        const parts = line.split(' ')
        result.push(
          `${parts[0]} ${parts[1]} ${parts[2]} ${this.audioConfig.index}`
        )
        return
      }
      if (line.indexOf('m=video') == 0 && this.videoConfig.index !== -1) {
        const parts = line.split(' ')
        result.push(
          `${parts[0]} ${parts[1]} ${parts[2]} ${this.videoConfig.index}`
        )
        return
      }
      result.push(line)
      if (line.indexOf('m=audio') === 0) {
        section = 'audio'
        hitMID = false
      } else if (line.indexOf('m=video') === 0) {
        section = 'video'
        hitMID = false
      } else if (line.indexOf('a=rtpmap') === 0) {
        section = 'bandwidth'
        hitMID = false
      }
      if (line.indexOf('a=mid:') !== 0 && line.indexOf('a=rtpmap') !== 0) {
        return
      }
      if (hitMID) {
        return
      }
      if ('audio'.localeCompare(section) === 0) {
        hitMID = true
        if (this.audioConfig.bitRate === undefined) {
          return
        }
        result = result.concat([
          `b=CT:${this.audioConfig.bitRate}`,
          `b=AS:${this.audioConfig.bitRate}`
        ])
      } else if ('video'.localeCompare(section) === 0) {
        hitMID = true
        if (this.videoConfig.bitRate === undefined) {
          return
        }
        result = result.concat([
          `b=CT:${this.videoConfig.bitRate}`,
          `b=AS:${this.videoConfig.bitRate}`
        ])
        if (this.videoConfig.frameRate === undefined) {
          return
        }
        result.push(`a=framerate:${this.videoConfig.frameRate}`)
      } else if ('bandwidth'.localeCompare(section) === 0) {
        const rtpmapID = this.getrtpMapID(line)
        if (rtpmapID === null) {
          return
        }
        const codec = rtpmapID[2].toLowerCase()
        const videoBitRate = this.genVideoBitRate(
          codec,
          rtpmapID[1],
          this.videoConfig.bitRate
        )
        if (videoBitRate !== undefined) {
          result.push(videoBitRate)
        }
        const audioBitRate = this.genAudioBitRate(
          codec,
          rtpmapID[1],
          this.audioConfig.bitRate
        )
        if (audioBitRate !== undefined) {
          result.push(audioBitRate)
        }
      }
    })
    return `${result.join('\r\n')}\r\n`
  }

  addAudio(lines, audioLine) {
    let result = []
    let done = false
    lines.forEach(line => {
      if (line.length === 0) {
        return
      }
      result.push(line)
      if (done) {
        return
      }
      if ('a=rtcp-mux'.localeCompare(line) === 0) {
        result = result.concat(audioLine.split(/\r\n/))
        done = true
      }
    })
    return result
  }

  addVideo(lines, videoLine) {
    logger.write('PUBLISHER BEFORE SDP', lines.join('\r\n'))
    let result = []
    let done = false
    let rtcpSize = false
    let rtcpMux = false
    lines.forEach(line => {
      if (line.length === 0) {
        return
      }
      if (line.includes('a=rtcp-rsize')) {
        rtcpSize = true
      }
      if (line.includes('a=rtcp-mux')) {
        rtcpMux = true
      }
    })
    lines.forEach(line => {
      result.push(line)
      if (
        'a=rtcp-rsize'.localeCompare(line) === 0 &&
        done === false &&
        rtcpSize === true
      ) {
        result = result.concat(videoLine.split(/\r\n/))
        done = true
      }
      if (
        'a=rtcp-mux'.localeCompare(line) === 0 &&
        done === true &&
        rtcpSize === false
      ) {
        result = result.concat(videoLine.split(/\r\n/))
        done = true
      }
      if (
        'a=rtcp-mux'.localeCompare(line) === 0 &&
        done === false &&
        rtcpSize === false
      ) {
        done = true
      }
    })
    logger.write('PUBLISHER AFTER SDP', result.join('\r\n'))
    return result
  }

  deliverCheckLine(profile, type) {
    let str = ''
    for (let line in this.SDPOutput) {
      const lineInUse = this.SDPOutput[line]
      str += line
      if (!lineInUse.includes(profile)) {
        continue
      }
      if (profile.includes('VP9') || profile.includes('VP8')) {
        let output = ''
        let outputs = lineInUse.split(/\r\n/)
        outputs.forEach(o => {
          if (
            o.indexOf('transport-cc') !== -1 ||
            o.indexOf('goog-remb') !== -1 ||
            o.indexOf('nack') !== -1
          ) {
            return
          }
          output += o + '\r\n'
        })
        if (type.includes('audio')) {
          this.audioConfig.index = line
        }
        if (type.includes('video')) {
          this.videoConfig.index = line
        }
        return output
      }
      if (type.includes('audio')) {
        this.audioConfig.index = line
      }
      if (type.includes('video')) {
        this.videoConfig.index = line
      }
      return lineInUse
    }
    return str
  }

  checkLine(line) {
    if (
      !line.startsWith('a=rtpmap') &&
      !line.startsWith('a=rtcp-fb') &&
      !line.startsWith('a=fmtp')
    ) {
      return true
    }
    const res = line.split(':')
    if (res.length <= 1) {
      return true
    }
    const number = res[1].split(' ')
    if (isNaN(number[0])) {
      return true
    }
    if (number[1].startsWith('http') || number[1].startsWith('ur')) {
      return true
    }
    let str = this.SDPOutput[number[0]]
    if (!str) {
      str = ''
    }
    str += line + '\r\n'
    this.SDPOutput[number[0]] = str
    return false
  }

  genVideoBitRate(codec, id, bitRate) {
    if (
      ('vp9'.localeCompare(codec) === 0 ||
        'vp8'.localeCompare(codec) === 0 ||
        'h264'.localeCompare(codec) === 0 ||
        'red'.localeCompare(codec) === 0 ||
        'ulpfec'.localeCompare(codec) === 0 ||
        'rtx'.localeCompare(codec) === 0) &&
      bitRate !== undefined
    ) {
      return `a=fmtp:${id} x-google-min-bitrate=${bitRate};x-google-max-bitrate=${bitRate}`
    }
    return undefined
  }

  genAudioBitRate(codec, id, bitRate) {
    if (
      ('opus'.localeCompare(codec) === 0 ||
        'isac'.localeCompare(codec) === 0 ||
        'g722'.localeCompare(codec) === 0 ||
        'pcmu'.localeCompare(codec) === 0 ||
        'pcma'.localeCompare(codec) === 0 ||
        'cn'.localeCompare(codec) === 0) &&
      bitRate !== undefined
    ) {
      return `a=fmtp:${id} x-google-min-bitrate=${bitRate};x-google-max-bitrate=${bitRate}`
    }
    return undefined
  }

  getrtpMapID(line) {
    const found = line.match(new RegExp('a=rtpmap:(\\d+) (\\w+)/(\\d+)'))
    return found && found.length >= 3 ? found : null
  }
}
