/**
 * The AI assistant panel.
 *
 * This is presentation and interaction only: it does not talk to any model, speech
 * recognition, or the project. The voice messages are placeholders and the "thinking"
 * delay is simulated so the states can be reviewed.
 *
 * The panel has two placements:
 *  - rail: docked on the right edge of the window, with the editor body leaving room for it
 *  - floating: a card over the bottom right corner of stage
 *
 * While docked it keeps an eye on the window width and asks the GUI to switch to its small
 * stage when the editor would otherwise not have room for the panel. The previous stage
 * size is restored when the panel floats again.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {STAGE_SIZE_MODES} from 'scratch-gui/src/lib/layout-constants';
import Icon from './icons.jsx';
import styles from './AIPanel.css';

// Below this window width the editor needs the small stage to fit next to the rail.
const SHRINK_BELOW = 1500;
// Floating card width; the height comes from its content.
const FLOATING_WIDTH = 300;

const VOICE_MESSAGES = [
  {role: 'user', duration: '0:06'},
  {role: 'ai', duration: '0:11'}
];

const INITIAL_TEXT_MESSAGES = [
  {role: 'user', text: '帮我做一个接苹果的游戏'},
  {role: 'ai', text: '好，我先搭好舞台，再加一个计分变量。'}
];

const STATUS_LABELS = {
  idle: '在线',
  listening: '聆听中',
  thinking: '思考中',
  reply: '已回复'
};

const Waveform = ({ai = false, playing = false, bars = 12}) => (
  <span
    className={`${styles.wave} ${ai ? styles.waveAi : ''} ${playing ? styles.wavePlaying : ''}`}
    aria-hidden="true"
  >
    {Array.from({length: bars}, (_, index) => <i key={index} />)}
  </span>
);

Waveform.propTypes = {
  ai: PropTypes.bool,
  playing: PropTypes.bool,
  bars: PropTypes.number
};

class AIPanel extends React.Component {
  constructor (props) {
    super(props);

    this.state = {
      mode: 'rail',
      tab: 'voice',
      voiceState: 'idle',
      textState: 'idle',
      input: '',
      textMessages: INITIAL_TEXT_MESSAGES,
      adopted: false,
      playing: false,
      floatingLeft: null,
      floatingBottom: null
    };

    /** Stage size the user had before the rail asked for the small stage. */
    this.previousStageSize = null;
    this.autoShrunk = false;
    this.stageObserver = null;
    this.replyTimer = null;
    this.textTimer = null;
    this.resizeTimer = null;
    this.positionFrame = null;
  }

  componentDidMount () {
    this.updateRailClass();
    this.evaluateStageSize();
    window.addEventListener('resize', this.handleWindowResize);
  }

  componentDidUpdate (prevProps, prevState) {
    if (prevState.mode !== this.state.mode) {
      this.updateRailClass();
      if (this.state.mode === 'rail') {
        this.unobserveStage();
        this.evaluateStageSize();
      } else {
        if (this.autoShrunk) {
          this.autoShrunk = false;
          this.props.onSetStageSize(this.previousStageSize || STAGE_SIZE_MODES.large);
        }
        this.scheduleFloatingPosition();
        this.observeStage();
      }
    }

    if (prevProps.stageSizeMode !== this.props.stageSizeMode) {
      // If the user picked a different stage size themselves, stop forcing it.
      if (this.autoShrunk && this.props.stageSizeMode !== STAGE_SIZE_MODES.small) {
        this.autoShrunk = false;
        this.previousStageSize = null;
      }
      if (this.state.mode === 'floating') {
        this.scheduleFloatingPosition();
      }
    }
  }

  componentWillUnmount () {
    document.documentElement.classList.remove('tw-ai-rail-open');
    window.removeEventListener('resize', this.handleWindowResize);
    window.removeEventListener('pointerup', this.finishListening);
    this.unobserveStage();
    this.clearTimers();
    if (this.positionFrame) {
      cancelAnimationFrame(this.positionFrame);
    }
    if (this.autoShrunk) {
      this.autoShrunk = false;
      this.props.onSetStageSize(this.previousStageSize || STAGE_SIZE_MODES.large);
    }
  }

  /**
   * The editor body leaves room for the rail. The rule lives in gui.css because it has to
   * target a scratch-gui class.
   */
  updateRailClass = () => {
    document.documentElement.classList.toggle('tw-ai-rail-open', this.state.mode === 'rail');
  };

  /**
   * Keep the current stage size when it fits; otherwise switch to the editor's small stage.
   */
  evaluateStageSize = () => {
    if (this.state.mode !== 'rail') {
      return;
    }

    const tooNarrow = window.innerWidth < SHRINK_BELOW;
    if (tooNarrow) {
      if (this.props.stageSizeMode !== STAGE_SIZE_MODES.small) {
        if (!this.autoShrunk) {
          this.previousStageSize = this.props.stageSizeMode;
          this.autoShrunk = true;
        }
        this.props.onSetStageSize(STAGE_SIZE_MODES.small);
      }
    } else if (this.autoShrunk) {
      this.autoShrunk = false;
      this.props.onSetStageSize(this.previousStageSize || STAGE_SIZE_MODES.large);
    }
  };

  handleWindowResize = () => {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.state.mode === 'rail') {
        this.evaluateStageSize();
      } else {
        this.scheduleFloatingPosition();
      }
    }, 150);
  };

  observeStage = () => {
    this.unobserveStage();
    const stage = this.getStageElement();
    if (!stage || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.stageObserver = new ResizeObserver(() => this.scheduleFloatingPosition());
    this.stageObserver.observe(stage);
  };

  unobserveStage = () => {
    if (this.stageObserver) {
      this.stageObserver.disconnect();
      this.stageObserver = null;
    }
  };

  getStageElement = () => document.querySelector("[class*='stage-wrapper_stage-wrapper_']");

  scheduleFloatingPosition = () => {
    if (this.positionFrame) {
      cancelAnimationFrame(this.positionFrame);
    }
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      this.positionFloating();
    });
  };

  /**
   * Puts the floating card over the bottom right corner of the stage, measured from the
   * live stage element so it follows stage size changes and window resizing.
   */
  positionFloating = () => {
    if (this.state.mode !== 'floating') {
      return;
    }
    const stage = this.getStageElement();
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    const left = Math.max(12, Math.min(
      window.innerWidth - FLOATING_WIDTH - 12,
      rect.right - FLOATING_WIDTH - 12
    ));
    const bottom = Math.max(12, window.innerHeight - rect.bottom + 12);
    if (left !== this.state.floatingLeft || bottom !== this.state.floatingBottom) {
      this.setState({
        floatingLeft: left,
        floatingBottom: bottom
      });
    }
  };

  switchPlacement = () => {
    this.setState({
      mode: this.state.mode === 'rail' ? 'floating' : 'rail'
    });
  };

  switchTab = (tab) => {
    if (tab === this.state.tab) {
      return;
    }
    this.clearVoiceTimers();
    window.removeEventListener('pointerup', this.finishListening);
    this.setState({
      tab,
      voiceState: 'idle'
    });
  };

  clearVoiceTimers = () => {
    if (this.replyTimer) {
      clearTimeout(this.replyTimer);
      this.replyTimer = null;
    }
  };

  clearTimers = () => {
    this.clearVoiceTimers();
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  };

  startListening = (event) => {
    if (event) {
      event.preventDefault();
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
    }
    if (this.state.voiceState === 'listening') {
      return;
    }
    this.clearVoiceTimers();
    this.setState({voiceState: 'listening'});
    window.addEventListener('pointerup', this.finishListening, {once: true});
  };

  finishListening = () => {
    window.removeEventListener('pointerup', this.finishListening);
    if (this.state.voiceState !== 'listening') {
      return;
    }
    this.setState({voiceState: 'thinking'});
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      this.setState({voiceState: 'reply'});
    }, 1300);
  };

  handleMicKeyDown = (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.startListening();
    }
  };

  handleMicKeyUp = (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.finishListening();
    }
  };

  handleInputChange = (event) => {
    this.setState({input: event.target.value});
  };

  handleInputKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.sendText();
    }
  };

  sendText = () => {
    const text = this.state.input.trim();
    if (!text) {
      return;
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    this.setState((state) => ({
      input: '',
      textState: 'thinking',
      textMessages: [...state.textMessages, {role: 'user', text}]
    }));
    this.textTimer = setTimeout(() => {
      this.textTimer = null;
      this.setState((state) => ({
        textState: 'reply',
        textMessages: [...state.textMessages, {
          role: 'ai',
          text: '收到，我按这个方向继续。'
        }]
      }));
    }, 1200);
  };

  renderStatus () {
    const state = this.state.tab === 'voice' ? this.state.voiceState : this.state.textState;
    return (
      <span className={`${styles.status} ${styles[`status_${state}`]}`}>
        <span className={styles.statusDot} />
        <span className={styles.statusText}>{STATUS_LABELS[state]}</span>
      </span>
    );
  }

  togglePlaying = () => {
    this.setState((state) => ({playing: !state.playing}));
  };

  toggleAdopted = () => {
    this.setState((state) => ({adopted: !state.adopted}));
  };

  regenerate = () => {
    this.clearVoiceTimers();
    this.setState({voiceState: 'thinking', playing: false});
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      this.setState({voiceState: 'reply'});
    }, 1200);
  };

  renderVoice () {
    const {voiceState, adopted, playing} = this.state;
    return (
      <div className={styles.conversation}>
        {VOICE_MESSAGES.map((message, index) => (
          <div
            key={index}
            className={`${styles.message} ${message.role === 'ai' ? styles.messageAi : ''}`}
          >
            {message.role === 'user' ? (
              <button
                type="button"
                className={styles.playButton}
                onClick={this.togglePlaying}
                aria-label={playing ? '暂停语音' : '播放语音'}
              >
                <Icon name={playing ? 'stop' : 'play'} size={12} />
              </button>
            ) : (
              <span className={styles.aiMark}><Icon name="sparkles" size={12} /></span>
            )}
            <Waveform ai={message.role === 'ai'} playing={playing && message.role === 'ai'} />
            <span className={styles.duration}>{message.duration}</span>
          </div>
        ))}
        {voiceState === 'reply' ? (
          <div className={`${styles.message} ${styles.messageAi} ${styles.replyMessage}`}>
            <span className={styles.aiMark}><Icon name="sparkles" size={12} /></span>
            <Waveform ai playing={playing} />
            <span className={styles.duration}>0:08</span>
          </div>
        ) : null}
        <div className={styles.chips}>
          <button type="button" className={styles.chip} onClick={this.togglePlaying}>
            <Icon name={playing ? 'stop' : 'play'} size={11} />{playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            className={`${styles.chip} ${adopted ? styles.chipActive : ''}`}
            onClick={this.toggleAdopted}
          >
            <Icon name="check" size={11} />{adopted ? '已采用' : '采用'}
          </button>
          <button type="button" className={styles.chip} onClick={this.regenerate}>
            <Icon name="redo" size={11} />重做
          </button>
        </div>
      </div>
    );
  }

  renderVoiceComposer () {
    const {voiceState} = this.state;
    if (voiceState === 'listening') {
      return (
        <div className={styles.listeningBar}>
          <span className={styles.listenWave} aria-hidden="true">
            {Array.from({length: 10}, (_, index) => <i key={index} />)}
          </span>
          <span className={styles.listeningText}>正在听…</span>
          <button type="button" className={styles.stopButton} onClick={this.finishListening} aria-label="结束录音">
            <Icon name="stop" size={13} />
          </button>
        </div>
      );
    }
    if (voiceState === 'thinking') {
      return (
        <div className={styles.thinkingBar}>
          <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
          正在想一想
        </div>
      );
    }
    return (
      <div className={styles.voiceComposer}>
        <button
          type="button"
          className={styles.micButton}
          onPointerDown={this.startListening}
          onKeyDown={this.handleMicKeyDown}
          onKeyUp={this.handleMicKeyUp}
          aria-label="按住说话"
        >
          <Icon name="mic" size={20} />
        </button>
        <span className={styles.composerCopy}>
          <b>按住说话</b>
          <span>松开发送</span>
        </span>
      </div>
    );
  }

  renderText () {
    const {textMessages, textState} = this.state;
    return (
      <div className={`${styles.conversation} ${styles.textConversation}`}>
        {textMessages.map((message, index) => (
          <div
            key={index}
            className={message.role === 'user' ? styles.bubbleUser : styles.bubbleAi}
          >
            {message.text}
          </div>
        ))}
        {textState === 'thinking' ? (
          <div className={styles.thinkingBubble}>
            <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
          </div>
        ) : null}
      </div>
    );
  }

  renderTextComposer () {
    const {input} = this.state;
    return (
      <div className={styles.textComposer}>
        <input
          type="text"
          className={styles.textInput}
          placeholder="说说你的想法…"
          value={input}
          onChange={this.handleInputChange}
          onKeyDown={this.handleInputKeyDown}
          aria-label="输入文字"
        />
        <button
          type="button"
          className={styles.sendButton}
          onClick={this.sendText}
          disabled={!input.trim()}
          aria-label="发送"
        >
          <Icon name="send" size={15} />
        </button>
      </div>
    );
  }

  render () {
    const {mode, tab} = this.state;
    const floating = mode === 'floating';
    const panelStyle = floating && this.state.floatingLeft !== null ? {
      left: this.state.floatingLeft,
      bottom: this.state.floatingBottom,
      right: 'auto'
    } : undefined;

    return (
      <section
        className={`${styles.panel} ${floating ? styles.floating : styles.rail}`}
        style={panelStyle}
        aria-label="南风 AI 助手"
      >
        <header className={styles.header}>
          <span className={styles.avatar}><Icon name="sparkles" size={14} /></span>
          <span className={styles.title}>南风 AI</span>
          {this.renderStatus()}
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={this.switchPlacement}
              title={floating ? '回到侧栏' : '悬浮到舞台'}
              aria-label={floating ? '回到侧栏' : '悬浮到舞台'}
            >
              <Icon name={floating ? 'rail' : 'float'} size={15} />
            </button>
          </span>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="对话方式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'voice'}
            className={`${styles.tab} ${tab === 'voice' ? styles.tabActive : ''}`}
            onClick={() => this.switchTab('voice')}
          >
            <Icon name="mic" size={13} />
            <span>语音</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            className={`${styles.tab} ${tab === 'text' ? styles.tabActive : ''}`}
            onClick={() => this.switchTab('text')}
          >
            <Icon name="type" size={13} />
            <span>文字</span>
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'voice' ? this.renderVoice() : this.renderText()}
        </div>
        {tab === 'voice' ? this.renderVoiceComposer() : this.renderTextComposer()}
      </section>
    );
  }
}

AIPanel.propTypes = {
  stageSizeMode: PropTypes.string.isRequired,
  onSetStageSize: PropTypes.func.isRequired
};

export default AIPanel;
