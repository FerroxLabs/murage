import { useEffect, useRef, useState } from "react";
import { LEARNING_NOTICE, learningNoticePending, markLearningNoticeShown, subscribeLearningNotice } from "@/lib/learning-consent";

/** A pending notice belongs to whichever mounted surface displays it first. */
export function LearningConsentNotice() {
  const [show, setShow] = useState(false);
  const notice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const resume = () => { setShow(learningNoticePending()); };
    const unsubscribe = subscribeLearningNotice(resume);
    resume();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (show && notice.current?.isConnected) {
      if (learningNoticePending()) markLearningNoticeShown();
      else setShow(false);
    }
  }, [show]);
  return show ? <p ref={notice} data-learning-notice role="status" className="pointer-events-auto mb-2 text-[12px] text-ink-secondary">{LEARNING_NOTICE}</p> : null;
}
