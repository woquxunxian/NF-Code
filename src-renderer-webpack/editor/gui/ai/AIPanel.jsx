/**
 * The AI assistant panel.
 *
 * This is presentation and interaction only: it does not talk to any model, speech
 * recognition, or the project. Voice messages are placeholders, the thinking delay is
 * simulated, and uploaded images stay local to the renderer.
 *
 * The panel has two placements:
 *  - rail: docked on the right edge of the window; its left edge can be dragged to resize
 *    it, and the editor body leaves room for it
 *  - floating: a card over the stage that can be dragged by long-pressing a blank area
 *
 * While docked it keeps an eye on how much room is left and asks the GUI to switch to its
 * small stage when the large stage would no longer fit. The previous stage size is restored
 * when the panel floats again.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {STAGE_SIZE_MODES} from 'scratch-gui/src/lib/layout-constants';
import Icon from './icons.jsx';
import styles from './AIPanel.css';

const DEFAULT_RAIL_WIDTH = 248;
const MIN_RAIL_WIDTH = 236;
const MAX_RAIL_WIDTH = 420;
// Keep this much editor width free when the rail is at its widest: palette, small stage and
// a usable workspace.
const MIN_BODY_FOR_SMALL_STAGE = 900;
// Below this much editor width the large stage no longer fits next to the rail.
const LARGE_LAYOUT_MIN = 1252;
// Floating card width; the height comes from its content.
const FLOATING_WIDTH = 300;
// Distance the pointer has to travel before a press on the top strip becomes a drag. Small
// enough that dragging starts as soon as the mouse moves, large enough that a click on a
// tab or the switch button still counts as a click.
const DRAG_START_DISTANCE = 4;

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
      voiceImages: [],
      attachment: null,
      adopted: false,
      playing: false,
      railWidth: DEFAULT_RAIL_WIDTH,
      dragging: false,
      floatingLeft: null,
      floatingBottom: null
    };

    this.panelRef = React.createRef();
    this.bodyRef = React.createRef();
    this.fileInputRef = React.createRef();

    /** Stage size the user had before the rail asked for the small stage. */
    this.previousStageSize = null;
    this.autoShrunk = false;
    this.customFloatingPosition = false;
    this.stageObserver = null;
    this.replyTimer = null;
    this.textTimer = null;
    this.resizeTimer = null;
    this.positionFrame = null;
    this.dragStart = null;
    this.dragActive = false;
    this.dragMoved = false;
    this.dragStartedInTabs = false;
    this.dragStartedOnSwitch = false;
    this.suppressNextClick = false;
    this.objectUrls = [];
  }

  componentDidMount () {
    const width = this.clampRailWidth(this.state.railWidth);
    if (width !== this.state.railWidth) {
      this.setState({railWidth: width});
    }
    this.applyRailWidth(width);
    if (!this.props.hidden) {
      this.updateRailClass();
      this.evaluateStageSize(width);
    }
    window.addEventListener('resize', this.handleWindowResize);
  }

  componentDidUpdate (prevProps, prevState) {
    if (prevProps.hidden !== this.props.hidden) {
      if (this.props.hidden) {
        document.documentElement.classList.remove('tw-ai-rail-open');
        this.unobserveStage();
      } else {
        this.updateRailClass();
        if (this.state.mode === 'rail') {
          this.evaluateStageSize();
        } else {
          this.scheduleFloatingPosition();
          this.observeStage();
        }
      }
    }

    if (prevState.railWidth !== this.state.railWidth) {
      this.applyRailWidth();
    }

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
    document.documentElement.classList.remove('tw-ai-dragging');
    document.documentElement.classList.remove('tw-ai-resizing');
    window.removeEventListener('resize', this.handleWindowResize);
    window.removeEventListener('pointermove', this.handleDragMove, true);
    window.removeEventListener('pointerup', this.finishDrag, true);
    window.removeEventListener('pointercancel', this.finishDrag, true);
    this.unobserveStage();
    this.clearTimers();
    if (this.positionFrame) {
      cancelAnimationFrame(this.positionFrame);
    }
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
    if (this.autoShrunk) {
      this.autoShrunk = false;
      this.props.onSetStageSize(this.previousStageSize || STAGE_SIZE_MODES.large);
    }
  }

  getMaxRailWidth = () => Math.max(
    MIN_RAIL_WIDTH,
    Math.min(MAX_RAIL_WIDTH, window.innerWidth - MIN_BODY_FOR_SMALL_STAGE)
  );

  clampRailWidth = (width) => Math.max(
    MIN_RAIL_WIDTH,
    Math.min(this.getMaxRailWidth(), Math.round(width))
  );

  applyRailWidth = (width = this.state.railWidth) => {
    document.documentElement.style.setProperty('--tw-ai-rail-width', `${width}px`);
  };

  /**
   * The editor body leaves room for the rail. The rule lives in gui.css because it has to
   * target a scratch-gui class.
   */
  updateRailClass = () => {
    const railOpen = this.state.mode === 'rail' && !this.props.hidden;
    document.documentElement.classList.toggle('tw-ai-rail-open', railOpen);
  };

  /**
   * Keep the current stage size when it fits; otherwise switch to the editor's small stage.
   * The available width depends on the current rail width, so resizing the rail re-runs this.
   * @param {number} railWidth
   */
  evaluateStageSize = (railWidth = this.state.railWidth) => {
    if (this.state.mode !== 'rail' || this.props.hidden) {
      return;
    }

    const available = window.innerWidth - railWidth;
    const tooNarrow = available < LARGE_LAYOUT_MIN;
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
      const clamped = this.clampRailWidth(this.state.railWidth);
      if (clamped !== this.state.railWidth) {
        this.setState({railWidth: clamped});
      }
      if (this.state.mode === 'rail') {
        this.evaluateStageSize(clamped);
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
    if (this.props.hidden) {
      return;
    }
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
   * live stage element so it follows stage size changes and window resizing. Once the user
   * has dragged the card, its position is left alone.
   */
  positionFloating = () => {
    if (this.state.mode !== 'floating' || this.customFloatingPosition) {
      return;
    }
    const stage = this.getStageElement();
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    const panel = this.panelRef.current;
    const height = panel ? panel.offsetHeight : 300;
    const left = Math.max(12, Math.min(
      window.innerWidth - FLOATING_WIDTH - 12,
      rect.right - FLOATING_WIDTH - 12
    ));
    const bottom = Math.max(8, Math.min(
      window.innerHeight - height - 8,
      window.innerHeight - rect.bottom + 12
    ));
    if (left !== this.state.floatingLeft || bottom !== this.state.floatingBottom) {
      this.setState({
        floatingLeft: left,
        floatingBottom: bottom
      });
    }
  };

  switchPlacement = () => {
    // A switch button long-press dragged the card; do not also change placement on release.
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    const next = this.state.mode === 'rail' ? 'floating' : 'rail';
    if (next === 'floating') {
      this.customFloatingPosition = false;
    }
    this.setState({mode: next});
  };

  switchTab = (tab) => {
    // A tab was long-pressed to drag the card; do not also switch tabs on release.
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (tab === this.state.tab) {
      return;
    }
    this.clearVoiceTimers();
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

  startListening = () => {
    this.clearVoiceTimers();
    this.setState({
      voiceState: 'listening',
      playing: false
    });
  };

  /**
   * Ends the recording, attaches an image if one is staged, then simulates the reply.
   */
  finishListening = () => {
    if (this.state.voiceState !== 'listening') {
      return;
    }
    const image = this.state.attachment ? this.state.attachment.url : null;
    this.setState((state) => ({
      voiceState: 'thinking',
      attachment: null,
      voiceImages: image ? [...state.voiceImages, image] : state.voiceImages
    }));
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      this.setState({voiceState: 'reply'});
    }, 1300);
  };

  toggleListening = () => {
    if (this.state.voiceState === 'listening') {
      this.finishListening();
    } else {
      this.startListening();
    }
  };

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

  openFilePicker = () => {
    if (this.fileInputRef.current) {
      this.fileInputRef.current.click();
    }
  };

  handleFileChange = (event) => {
    const file = event.target.files && event.target.files[0];
    // Allow selecting the same file again later
    event.target.value = '';
    if (!file) {
      return;
    }
    if (this.state.attachment) {
      URL.revokeObjectURL(this.state.attachment.url);
      this.objectUrls = this.objectUrls.filter((url) => url !== this.state.attachment.url);
    }
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    this.setState({
      attachment: {
        url,
        name: file.name
      }
    });
  };

  removeAttachment = () => {
    const {attachment} = this.state;
    if (!attachment) {
      return;
    }
    URL.revokeObjectURL(attachment.url);
    this.objectUrls = this.objectUrls.filter((url) => url !== attachment.url);
    this.setState({attachment: null});
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
    const image = this.state.attachment ? this.state.attachment.url : null;
    if (!text && !image) {
      return;
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
    this.setState((state) => ({
      input: '',
      attachment: null,
      textState: 'thinking',
      textMessages: [...state.textMessages, {role: 'user', text, image}]
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

  /* ------------------------------------------------------------------------------------
   * Floating card: press a blank area and move to drag it.
   * The header (except its buttons), the empty part of the message list and the panel
   * padding are the drag handles.
   * ---------------------------------------------------------------------------------- */

  handleTopBarPointerDown = (event) => {
    if (this.state.mode !== 'floating' || event.button !== 0) {
      return;
    }
    // The entire top strip is a drag handle, including the switch button. Moving the pointer
    // drags the card; a click on the switch still changes placement.
    event.stopPropagation();
    this.startDrag(event, false, !!event.target.closest('button'));
  };

  handlePanelPointerDown = (event) => {
    if (this.state.mode !== 'floating' || event.button !== 0) {
      return;
    }
    if (event.target.closest('[data-ai-drag="top"]')) {
      return;
    }
    // The tabs are buttons, but they are also part of the drag band: a click still switches
    // tabs, moving the pointer drags the card.
    const inTabs = !!event.target.closest('[data-ai-drag="tabs"]');
    if (!inTabs && event.target.closest('button, input, textarea, a, img, [role="tab"], [role="button"]')) {
      return;
    }
    const onEmptyBody = event.target === this.bodyRef.current;
    const onPadding = event.target === event.currentTarget;
    if (!inTabs && !onEmptyBody && !onPadding) {
      return;
    }
    this.startDrag(event, inTabs, false);
  };

  /**
   * @param {PointerEvent} event
   * @param {boolean} startedInTabs
   * @param {boolean} startedOnSwitch
   */
  startDrag = (event, startedInTabs, startedOnSwitch) => {
    const rect = this.panelRef.current.getBoundingClientRect();
    this.dragStartedInTabs = startedInTabs;
    this.dragStartedOnSwitch = startedOnSwitch;
    this.dragStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    this.dragActive = false;
    this.dragMoved = false;
    window.addEventListener('pointermove', this.handleDragMove, true);
    window.addEventListener('pointerup', this.finishDrag, true);
    window.addEventListener('pointercancel', this.finishDrag, true);
  };

  handleDragMove = (event) => {
    if (!this.dragStart) {
      return;
    }
    const dx = event.clientX - this.dragStart.pointerX;
    const dy = event.clientY - this.dragStart.pointerY;

    if (!this.dragActive) {
      // A press only becomes a drag once the pointer has actually moved, so clicks on the
      // tabs and the switch button still work. There is no long-press delay.
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= DRAG_START_DISTANCE) {
        return;
      }
      this.dragActive = true;
      this.dragMoved = true;
      this.customFloatingPosition = true;
      document.documentElement.classList.add('tw-ai-dragging');
      this.setState({dragging: true});
    }

    event.preventDefault();
    const left = Math.max(8, Math.min(
      window.innerWidth - this.dragStart.width - 8,
      this.dragStart.left + dx
    ));
    const top = Math.max(8, Math.min(
      window.innerHeight - this.dragStart.height - 8,
      this.dragStart.top + dy
    ));
    this.setState({
      floatingLeft: left,
      floatingBottom: window.innerHeight - (top + this.dragStart.height)
    });
  };

  finishDrag = () => {
    window.removeEventListener('pointermove', this.handleDragMove, true);
    window.removeEventListener('pointerup', this.finishDrag, true);
    window.removeEventListener('pointercancel', this.finishDrag, true);
    if (this.dragActive) {
      this.dragActive = false;
      document.documentElement.classList.remove('tw-ai-dragging');
      this.setState({dragging: false});
    }
    if (this.dragMoved && (this.dragStartedInTabs || this.dragStartedOnSwitch)) {
      // A drag started on a tab or the switch button; swallow the click it produces.
      this.suppressNextClick = true;
      setTimeout(() => {
        this.suppressNextClick = false;
      }, 250);
    }
    this.dragStart = null;
    this.dragActive = false;
    this.dragMoved = false;
    this.dragStartedInTabs = false;
    this.dragStartedOnSwitch = false;
  };

  /* ------------------------------------------------------------------------------------
   * Rail: drag the left edge to resize it.
   * ---------------------------------------------------------------------------------- */

  startRailResize = (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = this.state.railWidth;
    let latestWidth = startWidth;
    document.documentElement.classList.add('tw-ai-resizing');

    const onMove = (moveEvent) => {
      latestWidth = this.clampRailWidth(startWidth - (moveEvent.clientX - startX));
      if (latestWidth !== this.state.railWidth) {
        this.setState({railWidth: latestWidth});
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.documentElement.classList.remove('tw-ai-resizing');
      this.evaluateStageSize(latestWidth);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ------------------------------------------------------------------------------------
   * Rendering
   * ---------------------------------------------------------------------------------- */

  renderStatus () {
    const state = this.state.tab === 'voice' ? this.state.voiceState : this.state.textState;
    return (
      <span className={`${styles.status} ${styles[`status_${state}`]}`}>
        <span className={styles.statusDot} />
        <span className={styles.statusText}>{STATUS_LABELS[state]}</span>
      </span>
    );
  }

  renderAttachment () {
    const {attachment} = this.state;
    if (!attachment) {
      return null;
    }
    return (
      <div className={styles.attachment}>
        <img className={styles.attachmentThumb} src={attachment.url} alt="" />
        <span className={styles.attachmentName}>{attachment.name}</span>
        <button
          type="button"
          className={styles.attachmentRemove}
          onClick={this.removeAttachment}
          aria-label="移除图片"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    );
  }

  renderUploadButton () {
    return (
      <button
        type="button"
        className={styles.composerAction}
        onClick={this.openFilePicker}
        title="上传图片"
        aria-label="上传图片"
      >
        <Icon name="image" size={16} />
      </button>
    );
  }

  renderVoice () {
    const {voiceState, voiceImages, adopted, playing} = this.state;
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
        {voiceImages.map((url, index) => (
          <div key={index} className={styles.imageMessage}>
            <img src={url} alt="" />
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
          <button
            type="button"
            className={`${styles.micButton} ${styles.micButtonListening}`}
            onClick={this.finishListening}
            title="结束并发送"
            aria-label="结束并发送"
          >
            <Icon name="stop" size={16} />
          </button>
          <span className={styles.listenWave} aria-hidden="true">
            {Array.from({length: 10}, (_, index) => <i key={index} />)}
          </span>
          <span className={styles.listeningCopy}>
            <b>正在听…</b>
            <span>再点结束并发送</span>
          </span>
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
          onClick={this.toggleListening}
          title="点击说话"
          aria-label="点击说话"
        >
          <Icon name="mic" size={20} />
        </button>
        <span className={styles.composerCopy}>
          <b>点击说话</b>
          <span>再点一下结束并发送</span>
        </span>
        {this.renderUploadButton()}
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
            {message.image ? (
              <img className={styles.bubbleImage} src={message.image} alt="" />
            ) : null}
            {message.text ? <span>{message.text}</span> : null}
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
    const {input, attachment} = this.state;
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
        {this.renderUploadButton()}
        <button
          type="button"
          className={styles.sendButton}
          onClick={this.sendText}
          disabled={!input.trim() && !attachment}
          aria-label="发送"
        >
          <Icon name="send" size={15} />
        </button>
      </div>
    );
  }

  render () {
    if (this.props.hidden) {
      // Rendering nothing keeps the panel's state (conversation, staged image, width) alive
      // while the stage is in its own fullscreen mode.
      return null;
    }
    const {mode, tab, dragging, floatingLeft, floatingBottom} = this.state;
    const floating = mode === 'floating';
    const panelStyle = floating && floatingLeft !== null ? {
      left: floatingLeft,
      bottom: floatingBottom,
      right: 'auto'
    } : undefined;

    const header = (
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
    );

    return (
      <section
        ref={this.panelRef}
        className={[
          styles.panel,
          floating ? styles.floating : styles.rail,
          dragging ? styles.panelDragging : ''
        ].join(' ')}
        style={panelStyle}
        aria-label="南风 AI 助手"
        onPointerDown={floating ? this.handlePanelPointerDown : undefined}
      >
        {!floating ? (
          <div
            className={styles.resizeHandle}
            onPointerDown={this.startRailResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整助手宽度"
            title="拖动调整宽度"
          />
        ) : null}

        {floating ? (
          <div
            className={styles.topBar}
            data-ai-drag="top"
            onPointerDown={this.handleTopBarPointerDown}
            title="按住拖动"
          >
            <div className={styles.dragGrip} aria-hidden="true" />
            {header}
          </div>
        ) : header}

        <div className={styles.tabs} role="tablist" aria-label="对话方式" data-ai-drag="tabs">
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

        <div className={styles.body} ref={this.bodyRef} data-ai-drag="body">
          {tab === 'voice' ? this.renderVoice() : this.renderText()}
        </div>

        {this.renderAttachment()}

        {tab === 'voice' ? this.renderVoiceComposer() : this.renderTextComposer()}

        <input
          ref={this.fileInputRef}
          className={styles.fileInput}
          type="file"
          accept="image/*"
          onChange={this.handleFileChange}
        />
      </section>
    );
  }
}

AIPanel.propTypes = {
  hidden: PropTypes.bool,
  stageSizeMode: PropTypes.string.isRequired,
  onSetStageSize: PropTypes.func.isRequired
};

AIPanel.defaultProps = {
  hidden: false
};

export default AIPanel;
